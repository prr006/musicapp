// Package lyrics fetches lyrics from LRCLIB and parses LRC content into
// timed lines. Matching is done on title/artist/album/duration; the caller
// decides how to display the result. Timing is never generated here — the
// player's real position drives highlighting in the UI.
package lyrics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ErrNotFound = errors.New("no lyrics found")
	ErrNetwork  = errors.New("couldn't reach the lyrics service")
	ErrProvider = errors.New("the lyrics service returned an unexpected response")
)

const defaultBase = "https://lrclib.net"

type Line struct {
	Time float64 `json:"time"` // seconds
	Text string  `json:"text"`
}

type Result struct {
	TrackID       string  `json:"trackId"`
	Source        string  `json:"source"` // "lrclib"
	Synced        bool    `json:"synced"`
	Lines         []Line  `json:"lines"` // present when Synced
	Plain         string  `json:"plain"` // plain fallback text
	Instrumental  bool    `json:"instrumental"`
	Offset        float64 `json:"offset"` // seconds, from [offset:] tag
	MatchedTitle  string  `json:"matchedTitle"`
	MatchedArtist string  `json:"matchedArtist"`
}

type Query struct {
	TrackID  string  `json:"trackId"`
	Title    string  `json:"title"`
	Artist   string  `json:"artist"`
	Album    string  `json:"album"`
	Duration float64 `json:"duration"`
}

type Client struct {
	HTTP    *http.Client
	BaseURL string

	mu    sync.Mutex
	cache map[string]Result
}

func New() *Client {
	return &Client{
		HTTP:    &http.Client{Timeout: 12 * time.Second},
		BaseURL: defaultBase,
		cache:   map[string]Result{},
	}
}

// Fetch resolves lyrics for a query, using an in-memory cache keyed by track.
func (c *Client) Fetch(ctx context.Context, q Query) (Result, error) {
	key := q.TrackID
	if key == "" {
		key = q.Artist + "|" + q.Title
	}
	c.mu.Lock()
	if hit, ok := c.cache[key]; ok {
		c.mu.Unlock()
		return hit, nil
	}
	c.mu.Unlock()

	res, err := c.fetchUncached(ctx, q)
	if err != nil {
		return Result{}, err
	}
	res.TrackID = q.TrackID
	c.mu.Lock()
	c.cache[key] = res
	c.mu.Unlock()
	return res, nil
}

type apiRecord struct {
	ID           int     `json:"id"`
	TrackName    string  `json:"trackName"`
	ArtistName   string  `json:"artistName"`
	AlbumName    string  `json:"albumName"`
	Duration     float64 `json:"duration"`
	Instrumental bool    `json:"instrumental"`
	PlainLyrics  string  `json:"plainLyrics"`
	SyncedLyrics string  `json:"syncedLyrics"`
}

func (c *Client) fetchUncached(ctx context.Context, q Query) (Result, error) {
	title := CleanTitle(q.Title)
	artist := CleanArtist(q.Artist)
	if title == "" {
		return Result{}, ErrNotFound
	}

	// 1) exact get (best signal: includes duration)
	params := url.Values{}
	params.Set("track_name", title)
	params.Set("artist_name", artist)
	if q.Album != "" {
		params.Set("album_name", q.Album)
	}
	if q.Duration > 0 {
		params.Set("duration", strconv.Itoa(int(math.Round(q.Duration))))
	}
	rec, err := c.getOne(ctx, "/api/get?"+params.Encode())
	if err == nil {
		return toResult(*rec), nil
	}
	if !errors.Is(err, ErrNotFound) {
		return Result{}, err
	}

	// 2) search and pick the closest duration match
	sp := url.Values{}
	sp.Set("track_name", title)
	if artist != "" {
		sp.Set("artist_name", artist)
	}
	recs, err := c.search(ctx, "/api/search?"+sp.Encode())
	if err != nil {
		return Result{}, err
	}
	best := PickBest(recs, q.Duration)
	if best == nil {
		// 3) last try: free-text query
		fp := url.Values{}
		fp.Set("q", strings.TrimSpace(artist+" "+title))
		recs, err = c.search(ctx, "/api/search?"+fp.Encode())
		if err != nil {
			return Result{}, err
		}
		best = PickBest(recs, q.Duration)
	}
	if best == nil {
		return Result{}, ErrNotFound
	}
	return toResult(*best), nil
}

func (c *Client) do(ctx context.Context, path string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", "MELO/3.0 (https://github.com/prr006/musicapp)")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("%w: %v", ErrNetwork, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("%w: %v", ErrNetwork, err)
	}
	return body, resp.StatusCode, nil
}

func (c *Client) getOne(ctx context.Context, path string) (*apiRecord, error) {
	body, status, err := c.do(ctx, path)
	if err != nil {
		return nil, err
	}
	switch {
	case status == http.StatusNotFound:
		return nil, ErrNotFound
	case status != http.StatusOK:
		return nil, fmt.Errorf("%w (HTTP %d)", ErrProvider, status)
	}
	var rec apiRecord
	if err := json.Unmarshal(body, &rec); err != nil {
		return nil, fmt.Errorf("%w: malformed payload", ErrProvider)
	}
	if rec.SyncedLyrics == "" && rec.PlainLyrics == "" && !rec.Instrumental {
		return nil, ErrNotFound
	}
	return &rec, nil
}

func (c *Client) search(ctx context.Context, path string) ([]apiRecord, error) {
	body, status, err := c.do(ctx, path)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return nil, nil
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("%w (HTTP %d)", ErrProvider, status)
	}
	var recs []apiRecord
	if err := json.Unmarshal(body, &recs); err != nil {
		return nil, fmt.Errorf("%w: malformed payload", ErrProvider)
	}
	return recs, nil
}

// PickBest chooses the record whose duration is closest to want (within 10s),
// preferring synced lyrics.
func PickBest(recs []apiRecord, want float64) *apiRecord {
	var best *apiRecord
	bestScore := math.MaxFloat64
	for i := range recs {
		r := recs[i]
		if r.SyncedLyrics == "" && r.PlainLyrics == "" && !r.Instrumental {
			continue
		}
		score := 0.0
		if want > 0 && r.Duration > 0 {
			delta := math.Abs(r.Duration - want)
			if delta > 10 {
				continue
			}
			score = delta
		} else {
			score = 5
		}
		if r.SyncedLyrics == "" {
			score += 3
		}
		if score < bestScore {
			bestScore = score
			best = &recs[i]
		}
	}
	return best
}

func toResult(rec apiRecord) Result {
	res := Result{
		Source:        "lrclib",
		Plain:         strings.TrimSpace(rec.PlainLyrics),
		Instrumental:  rec.Instrumental,
		MatchedTitle:  rec.TrackName,
		MatchedArtist: rec.ArtistName,
	}
	if rec.SyncedLyrics != "" {
		lines, offset := ParseLRC(rec.SyncedLyrics)
		if len(lines) > 0 {
			res.Synced = true
			res.Lines = lines
			res.Offset = offset
		}
	}
	return res
}

// ---------------- LRC parsing ----------------

var (
	timeTagRe = regexp.MustCompile(`\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]`)
	metaRe    = regexp.MustCompile(`^\[([a-zA-Z]+):(.*)\]$`)
)

// ParseLRC converts LRC text into sorted lines plus the [offset:] value in
// seconds. Multi-timestamp lines produce one entry per timestamp. Malformed
// lines are skipped rather than failing the whole document.
func ParseLRC(raw string) ([]Line, float64) {
	var lines []Line
	var offset float64
	for _, rawLine := range strings.Split(raw, "\n") {
		line := strings.TrimRight(strings.TrimSpace(rawLine), "\r")
		if line == "" {
			continue
		}
		if m := metaRe.FindStringSubmatch(line); m != nil && !timeTagRe.MatchString(line) {
			if strings.EqualFold(m[1], "offset") {
				if ms, err := strconv.ParseFloat(strings.TrimSpace(m[2]), 64); err == nil {
					offset = ms / 1000
				}
			}
			continue
		}
		stamps := timeTagRe.FindAllStringSubmatch(line, -1)
		if len(stamps) == 0 {
			continue
		}
		text := strings.TrimSpace(timeTagRe.ReplaceAllString(line, ""))
		for _, s := range stamps {
			mins, _ := strconv.Atoi(s[1])
			secs, _ := strconv.Atoi(s[2])
			frac := 0.0
			if s[3] != "" {
				digits := s[3]
				v, _ := strconv.Atoi(digits)
				frac = float64(v) / math.Pow(10, float64(len(digits)))
			}
			lines = append(lines, Line{Time: float64(mins*60+secs) + frac, Text: text})
		}
	}
	sort.SliceStable(lines, func(i, j int) bool { return lines[i].Time < lines[j].Time })
	return lines, offset
}

var (
	bracketRe = regexp.MustCompile(`(?i)\s*[\(\[](official|lyrics?|audio|video|music video|hd|hq|4k|visualizer|mv|live|remaster(ed)?( \d{4})?|explicit|clean)[^\)\]]*[\)\]]`)
	featRe    = regexp.MustCompile(`(?i)\s*[\(\[]?(feat\.?|ft\.?|featuring)\s+[^\)\]]*[\)\]]?$`)
	suffixRe  = regexp.MustCompile(`(?i)\s*[-–|]\s*(official.*|lyrics?.*|audio|topic)$`)
)

// CleanTitle strips the noise YouTube titles carry so LRCLIB can match.
func CleanTitle(t string) string {
	out := strings.TrimSpace(t)
	out = bracketRe.ReplaceAllString(out, "")
	out = suffixRe.ReplaceAllString(out, "")
	out = featRe.ReplaceAllString(out, "")
	return strings.TrimSpace(strings.Trim(out, "-–|· "))
}

// CleanArtist removes the "- Topic" suffix and collapses multi-artist strings
// to the primary artist, which matches LRCLIB's indexing much better.
func CleanArtist(a string) string {
	out := strings.TrimSpace(a)
	out = regexp.MustCompile(`(?i)\s*-\s*topic$`).ReplaceAllString(out, "")
	out = regexp.MustCompile(`(?i)\s*vevo$`).ReplaceAllString(out, "")
	for _, sep := range []string{" & ", ", ", " x ", " X ", " feat. ", " ft. "} {
		if i := strings.Index(out, sep); i > 0 {
			out = out[:i]
		}
	}
	return strings.TrimSpace(out)
}
