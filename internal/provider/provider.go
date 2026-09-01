// Package provider implements music search. The primary source is the
// YouTube Music InnerTube endpoint (rich metadata: artist, album, artwork,
// duration); when it is unavailable or its shape changes, search falls back to
// yt-dlp's own search, which is slower but very stable.
//
// Nothing here knows about playback: the output is plain model.Track values.
package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"melo/internal/model"
)

var (
	ErrNetwork  = errors.New("couldn't reach YouTube")
	ErrProvider = errors.New("YouTube Music returned an unexpected response")
)

const (
	innertubeURL = "https://music.youtube.com/youtubei/v1/search?prettyPrint=false"
	clientName   = "WEB_REMIX"
	clientVer    = "1.20240403.01.00"
	userAgent    = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

type YTDLPRunner interface {
	// Run executes yt-dlp with args and returns stdout.
	Run(ctx context.Context, args ...string) ([]byte, error)
}

type Client struct {
	HTTP  *http.Client
	YTDLP YTDLPRunner
	// Endpoint is overridable for tests.
	Endpoint string
}

func New(ytdlp YTDLPRunner) *Client {
	return &Client{
		HTTP:     &http.Client{Timeout: 20 * time.Second},
		YTDLP:    ytdlp,
		Endpoint: innertubeURL,
	}
}

// Search runs a query and returns grouped results. filter is "" (everything),
// "songs" or "videos".
func (c *Client) Search(ctx context.Context, query, filter string) (model.SearchResponse, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return model.SearchResponse{Query: query}, nil
	}
	res, err := c.searchInnerTube(ctx, query, filter)
	if err == nil && len(res.Songs)+len(res.Videos) > 0 {
		return res, nil
	}
	fallback, ferr := c.searchYTDLP(ctx, query)
	if ferr == nil && len(fallback.Songs) > 0 {
		return fallback, nil
	}
	if err != nil {
		return model.SearchResponse{Query: query}, err
	}
	if ferr != nil {
		return model.SearchResponse{Query: query}, ferr
	}
	return res, nil
}

func filterParams(filter string) string {
	switch filter {
	case "songs":
		return "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D"
	case "videos":
		return "EgWKAQIQAWoKEAkQChAFEAMQBA%3D%3D"
	case "albums":
		return "EgWKAQIYAWoKEAkQChAFEAMQBA%3D%3D"
	default:
		return ""
	}
}

func (c *Client) searchInnerTube(ctx context.Context, query, filter string) (model.SearchResponse, error) {
	out := model.SearchResponse{Query: query, Provider: "ytmusic"}
	payload := map[string]any{
		"context": map[string]any{
			"client": map[string]any{
				"clientName":    clientName,
				"clientVersion": clientVer,
				"hl":            "en",
				"gl":            "US",
			},
		},
		"query": query,
	}
	if p := filterParams(filter); p != "" {
		payload["params"] = p
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Endpoint, bytes.NewReader(body))
	if err != nil {
		return out, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Origin", "https://music.youtube.com")
	req.Header.Set("Referer", "https://music.youtube.com/")
	req.Header.Set("X-Goog-Visitor-Id", "")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return out, fmt.Errorf("%w: %v", ErrNetwork, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("%w (HTTP %d)", ErrProvider, resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 12<<20))
	if err != nil {
		return out, fmt.Errorf("%w: %v", ErrNetwork, err)
	}
	parsed, err := ParseSearchResponse(raw)
	if err != nil {
		return out, err
	}
	parsed.Query = query
	parsed.Provider = "ytmusic"
	return parsed, nil
}

// ---------------- InnerTube parsing ----------------

var durationRe = regexp.MustCompile(`^\d{1,2}:\d{2}(:\d{2})?$`)
var yearRe = regexp.MustCompile(`^(19|20)\d{2}$`)

// ParseSearchResponse walks an InnerTube search payload defensively: rather
// than relying on the exact renderer nesting (which changes often), it finds
// every list item renderer and extracts what is present.
func ParseSearchResponse(raw []byte) (model.SearchResponse, error) {
	var root any
	if err := json.Unmarshal(raw, &root); err != nil {
		return model.SearchResponse{}, fmt.Errorf("%w: malformed JSON", ErrProvider)
	}
	items := []map[string]any{}
	collect(root, "musicResponsiveListItemRenderer", &items)
	if len(items) == 0 {
		collect(root, "musicTwoRowItemRenderer", &items)
	}
	out := model.SearchResponse{}
	seen := map[string]bool{}
	for _, it := range items {
		videoID := firstString(it, "videoId")
		browseID := firstString(it, "browseId")
		title, runs := columns(it)
		artwork := bestThumbnail(it)
		if title == "" {
			continue
		}
		switch {
		case videoID != "":
			if seen["v:"+videoID] {
				continue
			}
			seen["v:"+videoID] = true
			t := model.Track{
				ID:       "yt:" + videoID,
				SourceID: videoID,
				Source:   "youtube",
				URL:      "https://music.youtube.com/watch?v=" + videoID,
				Title:    title,
				Artwork:  artwork,
				Explicit: hasExplicitBadge(it),
			}
			var artistParts []string
			for _, r := range runs {
				switch {
				case durationRe.MatchString(r.Text):
					t.Duration = parseClock(r.Text)
				case strings.HasPrefix(r.BrowseID, "MPRE"):
					t.Album = r.Text
				case strings.HasPrefix(r.BrowseID, "UC"):
					artistParts = append(artistParts, r.Text)
				}
			}
			if len(artistParts) == 0 {
				// No browse endpoints (typical for video results): the first
				// run that is neither a type label nor a duration is the channel.
				for _, r := range runs {
					if isTypeLabel(r.Text) || durationRe.MatchString(r.Text) || viewsRe.MatchString(r.Text) {
						continue
					}
					artistParts = append(artistParts, r.Text)
					break
				}
			}
			t.Artist = strings.Join(uniqueStrings(artistParts), ", ")
			if isVideoType(runs) {
				out.Videos = append(out.Videos, t)
			} else {
				out.Songs = append(out.Songs, t)
			}
		case strings.HasPrefix(browseID, "MPRE"):
			if seen["a:"+browseID] {
				continue
			}
			seen["a:"+browseID] = true
			al := model.Album{ID: browseID, Title: title, Artwork: artwork}
			for _, r := range runs {
				if yearRe.MatchString(r.Text) {
					al.Year = r.Text
				} else if strings.HasPrefix(r.BrowseID, "UC") || al.Artist == "" && r.Text != "Album" && r.Text != "Single" && r.Text != "EP" {
					if al.Artist == "" {
						al.Artist = r.Text
					}
				}
			}
			out.Albums = append(out.Albums, al)
		case strings.HasPrefix(browseID, "UC"):
			if seen["r:"+browseID] {
				continue
			}
			seen["r:"+browseID] = true
			out.Artists = append(out.Artists, model.Artist{ID: browseID, Name: title, Artwork: artwork})
		}
	}
	if len(out.Songs)+len(out.Videos)+len(out.Albums)+len(out.Artists) == 0 {
		return out, nil
	}
	return out, nil
}

var viewsRe = regexp.MustCompile(`(?i)^[\d.,]+[KMB]? (views|plays)$`)

var typeLabels = map[string]bool{
	"song": true, "video": true, "music video": true, "album": true,
	"single": true, "ep": true, "artist": true, "playlist": true, "episode": true,
}

func isTypeLabel(s string) bool { return typeLabels[strings.ToLower(strings.TrimSpace(s))] }

func isVideoType(runs []run) bool {
	for _, r := range runs {
		switch strings.ToLower(r.Text) {
		case "video", "music video":
			return true
		case "song":
			return false
		}
	}
	return false
}

type run struct {
	Text     string
	BrowseID string
	VideoID  string
}

// columns returns the item's title plus the runs of the remaining columns.
func columns(item map[string]any) (string, []run) {
	var cols []any
	if v, ok := item["flexColumns"].([]any); ok {
		cols = v
	}
	var title string
	var rest []run
	for i, c := range cols {
		rs := runsOf(c)
		if i == 0 {
			if len(rs) > 0 {
				title = rs[0].Text
			}
			continue
		}
		for _, r := range rs {
			if strings.TrimSpace(r.Text) == "" || r.Text == " • " {
				continue
			}
			rest = append(rest, r)
		}
	}
	if title == "" {
		// musicTwoRowItemRenderer shape
		if t, ok := item["title"]; ok {
			if rs := runsOfValue(t); len(rs) > 0 {
				title = rs[0].Text
			}
		}
		if s, ok := item["subtitle"]; ok {
			rest = append(rest, runsOfValue(s)...)
		}
	}
	return title, rest
}

func runsOf(col any) []run {
	m, ok := col.(map[string]any)
	if !ok {
		return nil
	}
	inner, ok := m["musicResponsiveListItemFlexColumnRenderer"].(map[string]any)
	if !ok {
		return runsOfValue(col)
	}
	return runsOfValue(inner["text"])
}

func runsOfValue(v any) []run {
	m, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	arr, ok := m["runs"].([]any)
	if !ok {
		if s, ok := m["simpleText"].(string); ok {
			return []run{{Text: s}}
		}
		return nil
	}
	var out []run
	for _, r := range arr {
		rm, ok := r.(map[string]any)
		if !ok {
			continue
		}
		text, _ := rm["text"].(string)
		if strings.TrimSpace(text) == "" || strings.TrimSpace(text) == "•" {
			continue
		}
		out = append(out, run{
			Text:     text,
			BrowseID: firstString(rm, "browseId"),
			VideoID:  firstString(rm, "videoId"),
		})
	}
	return out
}

func bestThumbnail(item map[string]any) string {
	var best string
	var bestW float64
	var walk func(v any)
	walk = func(v any) {
		switch t := v.(type) {
		case map[string]any:
			if arr, ok := t["thumbnails"].([]any); ok {
				for _, e := range arr {
					em, ok := e.(map[string]any)
					if !ok {
						continue
					}
					url, _ := em["url"].(string)
					w, _ := em["width"].(float64)
					if url != "" && w >= bestW {
						best, bestW = url, w
					}
				}
			}
			for _, v2 := range t {
				walk(v2)
			}
		case []any:
			for _, v2 := range t {
				walk(v2)
			}
		}
	}
	walk(item)
	return upgradeThumb(best)
}

// upgradeThumb asks Google's image CDN for a larger square crop when the URL
// carries the standard size suffix. This is still the provider's real artwork.
func upgradeThumb(u string) string {
	if u == "" {
		return ""
	}
	if i := strings.Index(u, "=w"); i > 0 && strings.Contains(u, "-h") {
		return u[:i] + "=w544-h544-l90-rj"
	}
	return u
}

func hasExplicitBadge(item map[string]any) bool {
	raw, err := json.Marshal(item["badges"])
	if err != nil {
		return false
	}
	return strings.Contains(string(raw), "MUSIC_EXPLICIT_BADGE")
}

// collect finds every value stored under key anywhere in the tree.
func collect(v any, key string, out *[]map[string]any) {
	switch t := v.(type) {
	case map[string]any:
		for k, v2 := range t {
			if k == key {
				if m, ok := v2.(map[string]any); ok {
					*out = append(*out, m)
					continue
				}
			}
			collect(v2, key, out)
		}
	case []any:
		for _, v2 := range t {
			collect(v2, key, out)
		}
	}
}

// firstString finds the first string value for key anywhere in the subtree.
func firstString(v any, key string) string {
	switch t := v.(type) {
	case map[string]any:
		if s, ok := t[key].(string); ok {
			return s
		}
		for _, v2 := range t {
			if s := firstString(v2, key); s != "" {
				return s
			}
		}
	case []any:
		for _, v2 := range t {
			if s := firstString(v2, key); s != "" {
				return s
			}
		}
	}
	return ""
}

func parseClock(s string) float64 {
	parts := strings.Split(s, ":")
	total := 0.0
	for _, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return 0
		}
		total = total*60 + float64(n)
	}
	return total
}

func uniqueStrings(in []string) []string {
	seen := map[string]bool{}
	out := in[:0]
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

// ---------------- yt-dlp fallback ----------------

type ytdlpEntry struct {
	ID         string  `json:"id"`
	Title      string  `json:"title"`
	Uploader   string  `json:"uploader"`
	Channel    string  `json:"channel"`
	Artist     string  `json:"artist"`
	Album      string  `json:"album"`
	Track      string  `json:"track"`
	Duration   float64 `json:"duration"`
	WebpageURL string  `json:"webpage_url"`
	Thumbnails []struct {
		URL    string `json:"url"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
	} `json:"thumbnails"`
	Thumbnail string `json:"thumbnail"`
}

func (c *Client) searchYTDLP(ctx context.Context, query string) (model.SearchResponse, error) {
	if c.YTDLP == nil {
		return model.SearchResponse{}, ErrProvider
	}
	out, err := c.YTDLP.Run(ctx, "--dump-single-json", "--flat-playlist", "--no-warnings",
		fmt.Sprintf("ytsearch25:%s", query))
	if err != nil {
		return model.SearchResponse{}, fmt.Errorf("%w: %v", ErrNetwork, err)
	}
	return ParseYTDLPSearch(out, query)
}

func ParseYTDLPSearch(raw []byte, query string) (model.SearchResponse, error) {
	var payload struct {
		Entries []ytdlpEntry `json:"entries"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return model.SearchResponse{}, fmt.Errorf("%w: malformed yt-dlp output", ErrProvider)
	}
	res := model.SearchResponse{Query: query, Provider: "yt-dlp"}
	for _, e := range payload.Entries {
		if e.ID == "" {
			continue
		}
		res.Songs = append(res.Songs, TrackFromYTDLP(e.ID, e.Title, firstNonEmpty(e.Artist, e.Uploader, e.Channel),
			e.Album, bestEntryThumb(e), e.Duration))
	}
	return res, nil
}

func bestEntryThumb(e ytdlpEntry) string {
	best := e.Thumbnail
	bw := 0
	for _, t := range e.Thumbnails {
		if t.Width >= bw && t.URL != "" {
			best, bw = t.URL, t.Width
		}
	}
	if best == "" {
		best = "https://i.ytimg.com/vi/" + e.ID + "/hqdefault.jpg"
	}
	return best
}

func TrackFromYTDLP(id, title, artist, album, artwork string, duration float64) model.Track {
	return model.Track{
		ID:       "yt:" + id,
		SourceID: id,
		Source:   "youtube",
		URL:      "https://www.youtube.com/watch?v=" + id,
		Title:    strings.TrimSpace(title),
		Artist:   strings.TrimSpace(artist),
		Album:    strings.TrimSpace(album),
		Artwork:  artwork,
		Duration: duration,
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// Exec is the production YTDLPRunner backed by the managed binary.
type Exec struct {
	Path func() (string, error)
}

func (e Exec) Run(ctx context.Context, args ...string) ([]byte, error) {
	bin, err := e.Path()
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	hideWindow(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, errors.New(msg)
	}
	return out, nil
}
