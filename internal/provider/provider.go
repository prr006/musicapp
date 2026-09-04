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
	nextURL      = "https://music.youtube.com/youtubei/v1/next?prettyPrint=false"
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
	// NextEndpoint (the watch-next / radio endpoint) is overridable for tests.
	NextEndpoint string
}

func New(ytdlp YTDLPRunner) *Client {
	return &Client{
		HTTP:         &http.Client{Timeout: 20 * time.Second},
		YTDLP:        ytdlp,
		Endpoint:     innertubeURL,
		NextEndpoint: nextURL,
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
			var channel string
			for _, r := range runs {
				switch {
				case durationRe.MatchString(r.Text):
					t.Duration = parseClock(r.Text)
				case strings.HasPrefix(r.BrowseID, "MPRE"):
					if t.Album == "" {
						t.Album = r.Text
						t.AlbumBrowseID = r.BrowseID
					}
				case strings.HasPrefix(r.BrowseID, "UC"):
					artistParts = append(artistParts, r.Text)
					t.ArtistSrc = "browse"
					if t.ArtistBrowseID == "" {
						t.ArtistBrowseID = r.BrowseID
					}
				}
			}
			if len(artistParts) == 0 {
				// No browse endpoints (typical for video results): the first
				// run that is neither a type label nor a duration is the
				// channel/uploader — kept out of Artist unless the channel is
				// an official "<Artist> - Topic" artist channel.
				for _, r := range runs {
					if isTypeLabel(r.Text) || durationRe.MatchString(r.Text) || viewsRe.MatchString(r.Text) {
						continue
					}
					channel = r.Text
					t.UploaderChannelID = r.BrowseID
					break
				}
				if artist, ok := artistFromChannel(channel); ok {
					artistParts = append(artistParts, artist)
					t.ArtistSrc = "topic"
				}
			}
			t.Artist = strings.Join(uniqueStrings(artistParts), ", ")
			t.Uploader = channel
			if isVideoType(runs) {
				t.Via = "search:video"
				out.Videos = append(out.Videos, t)
			} else {
				t.Via = "search:song"
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

// ---------------- artist / channel identity ----------------

// artistFromChannel reports the performing artist for a bare channel name,
// ok=true only when the provider's naming explicitly identifies an artist.
// YouTube's auto-generated "<Artist> - Topic" channels are official artist
// channels, so they are the one channel shape that may become an artist.
// Everything else (personal channels, "X Official", VEVO variants…) stays an
// uploader: guessing an artist from a channel name is how "Farben (Slowed)"
// uploaded by a channel called "fearless" once turned into a radio full of
// songs merely titled "Fearless".
func artistFromChannel(channel string) (artist string, ok bool) {
	name := strings.TrimSpace(channel)
	if s := strings.TrimSuffix(name, "- Topic"); s != name {
		return strings.TrimSpace(s), true
	}
	return "", false
}

// ---------------- related music (radio) ----------------

// Related returns the provider's dedicated related-music list for one video —
// the input to MELO's autoplay radio. It deliberately does NOT use ordinary
// search results: the candidates come from the same "Up next" watch feed
// YouTube Music itself plays.
//
// Source ladder (tagged in the response so the UI can show where the radio
// came from):
//  1. "ytmusic-next" — the InnerTube /next watch-next endpoint for the video
//     (music.youtube.com's own continuation/radio panel).
//  2. "yt-dlp-mix"   — the YouTube mix playlist RD<videoID>, dumped flat via
//     yt-dlp. Slower, but stable and still a real related feed.
//
// If both fail the error from the primary source is returned; the caller is
// expected to fall back to its own deterministic metadata queries.
// RadioStage is one recommendation source, fetched in isolation: which
// endpoint produced it, and the candidates it yielded (each row carrying
// provenance in Track.Via and Track.ArtistSrc).
type RadioStage struct {
	Kind     string // "queue","automix","radio","ytdlp-mix",…
	Endpoint string // human-readable description of the request
	Note     string // diagnostics: why an empty stage is empty
	Tracks   []model.Track
}

// Related returns the provider's dedicated related-music list for one video —
// the input to MELO's autoplay radio. It deliberately does NOT use ordinary
// search: candidates come from YouTube Music's own recommendation surfaces
// only. Each stage of the ladder is kept separate until the end, because a
// stage that is >60% one artist (an artist-heavy "Up next" queue) must not be
// allowed to define the whole radio when another stage is a genuinely mixed
// recommendation feed: SelectRadioStages promotes the mixed source to lead.
func (c *Client) Related(ctx context.Context, videoID string) (model.RadioResponse, error) {
	videoID = strings.TrimSpace(videoID)
	if videoID == "" {
		return model.RadioResponse{}, nil
	}
	stages, err := c.innerTubeStages(ctx, videoID, false)
	if len(stages) == 0 || NeedsBroaderSources(stages) {
		// Last network rung: the auto-generated mix playlist RD<videoID>
		// dumped flat via yt-dlp — fetched only when InnerTube answered
		// nothing usable, or when every InnerTube stage is artist-heavy.
		if mix, ferr := c.relatedYTDLP(ctx, videoID); ferr == nil && len(mix.Tracks) > 0 {
			stages = append(stages, RadioStage{
				Kind:     "ytdlp-mix",
				Endpoint: "yt-dlp playlist RD" + videoID,
				Tracks:   mix.Tracks,
			})
		}
	}
	if len(flattenStages(stages)) == 0 {
		if err != nil {
			return model.RadioResponse{}, err
		}
		return model.RadioResponse{}, nil
	}
	return stageResponse(SelectRadioStages(stages)), nil
}

// DiagnoseRelated fetches EVERY recommendation source for a video SEPARATELY
// and returns one stage per source — including sources that answer nothing,
// so the report shows the full pipeline rather than the first hit:
//
//	queue / related-videos / music-shelves / tiles — the four surfaces of
//	    the videoId /next response, each its own stage (empty ones kept);
//	automix — the automixPreviewVideoRenderer continuation (the stage's Note
//	    records whether the preview existed at all);
//	continuation — up to two extra continuation requests the response itself
//	    generated (continuationItemRenderer tokens);
//	radio — the RDAMVM<videoID> song-radio playlist;
//	ytdlp-mix — the RD<videoID> mix via yt-dlp (Note records why it was
//	    skipped when it was).
//
// No selection or filtering is applied: this is the raw evidence for
// reconciling "the diagnostic says X" with "the app played Y".
func (c *Client) DiagnoseRelated(ctx context.Context, videoID string) ([]RadioStage, error) {
	videoID = strings.TrimSpace(videoID)
	clientCtx := map[string]any{
		"context": map[string]any{
			"client": map[string]any{
				"clientName":    clientName,
				"clientVersion": clientVer,
				"hl":            "en",
				"gl":            "US",
			},
		},
	}
	stages := []RadioStage{}
	raw, err := c.postNext(ctx, mergeMaps(clientCtx, map[string]any{"videoId": videoID}))
	if err != nil {
		stages = append(stages, RadioStage{Kind: "queue", Endpoint: "next(videoId " + videoID + ")",
			Note: "request failed: " + err.Error()})
		return stages, err
	}
	surfaces, perr := parseNextSurfaces(raw)
	if perr != nil {
		stages = append(stages, RadioStage{Kind: "queue", Endpoint: "next(videoId " + videoID + ")",
			Note: "malformed payload: " + perr.Error()})
		return stages, perr
	}
	for _, kind := range nextSurfaceOrder {
		stages = append(stages, RadioStage{
			Kind:     kind,
			Endpoint: "next(videoId " + videoID + ")",
			Note:     rendererForSurface[kind] + ": " + itoa(len(surfaces[kind])) + " rows",
			Tracks:   surfaces[kind],
		})
	}

	var root any
	_ = json.Unmarshal(raw, &root)

	// automix preview: present or not, and what its continuation answers.
	previews := []map[string]any{}
	collect(root, "automixPreviewVideoRenderer", &previews)
	automix := RadioStage{Kind: "automix", Endpoint: "next(automixPreviewVideoRenderer continuation)"}
	if len(previews) == 0 {
		automix.Note = "automixPreviewVideoRenderer: ABSENT in the videoId response"
	} else {
		token := continuationToken(previews[0])
		if token == "" {
			automix.Note = "automixPreviewVideoRenderer present but carries NO continuation token"
		} else {
			automix.Note = "automixPreviewVideoRenderer present, continuation followed"
			if next, cerr := c.postNext(ctx, mergeMaps(clientCtx, map[string]any{"continuation": token})); cerr == nil {
				if mixSurfaces, mperr := parseNextSurfaces(next); mperr == nil {
					for _, kind := range nextSurfaceOrder {
						automix.Tracks = append(automix.Tracks, mixSurfaces[kind]...)
					}
				}
			} else {
				automix.Note += " (request failed: " + cerr.Error() + ")"
			}
		}
	}
	stages = append(stages, automix)

	// any other continuations the response generated (shelf continuation
	// items), bounded to keep the report quick.
	items := []map[string]any{}
	collect(root, "continuationItemRenderer", &items)
	fetched := 0
	for _, item := range items {
		if fetched >= 2 {
			break
		}
		token := continuationToken(item)
		if token == "" {
			continue
		}
		fetched++
		stage := RadioStage{
			Kind:     "continuation",
			Endpoint: "next(continuationItemRenderer token " + token[:min(12, len(token))] + "…)",
		}
		if next, cerr := c.postNext(ctx, mergeMaps(clientCtx, map[string]any{"continuation": token})); cerr == nil {
			if cs, cperr := parseNextSurfaces(next); cperr == nil {
				for _, kind := range nextSurfaceOrder {
					stage.Tracks = append(stage.Tracks, cs[kind]...)
				}
			}
		} else {
			stage.Note = "request failed: " + cerr.Error()
		}
		stages = append(stages, stage)
	}

	// RDAMVM song radio.
	radio := RadioStage{Kind: "radio", Endpoint: "next(RDAMVM" + videoID + ")"}
	if rraw, rerr := c.postNext(ctx, mergeMaps(clientCtx, map[string]any{"playlistId": "RDAMVM" + videoID})); rerr == nil {
		if rs, rperr := parseNextSurfaces(rraw); rperr == nil {
			for _, kind := range nextSurfaceOrder {
				radio.Tracks = append(radio.Tracks, rs[kind]...)
			}
			radio.Note = "RDAMVM song-radio playlist"
		} else {
			radio.Note = "malformed payload: " + rperr.Error()
		}
	} else {
		radio.Note = "request failed: " + rerr.Error()
	}
	stages = append(stages, radio)

	// yt-dlp mix, if a runner is wired.
	mix := RadioStage{Kind: "ytdlp-mix", Endpoint: "yt-dlp playlist RD" + videoID}
	if c.YTDLP == nil {
		mix.Note = "not attempted: no yt-dlp runner configured"
	} else if m, merr := c.relatedYTDLP(ctx, videoID); merr == nil {
		mix.Tracks = m.Tracks
		mix.Note = "RD mix dumped flat"
	} else {
		mix.Note = "failed: " + merr.Error()
	}
	stages = append(stages, mix)

	return stages, nil
}

func itoa(n int) string { return fmt.Sprintf("%d", n) }

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// innerTubeStages runs the InnerTube ladder, keeping each stage separate:
//
//  1. "queue"  — the /next answer for the video (itself split into surfaces:
//     queue panel, compact related videos, music shelves, tiles);
//  2. "automix" — the autoplay preview continuation (the request YouTube
//     Music itself makes to expand the radio);
//  3. "radio"  — the RDAMVM<videoID> song-radio playlist.
//
// In production (diag=false) the ladder stops as soon as the merged stages
// are a usable, non-artist-dominated feed. In diagnosis mode (diag=true) all
// stages are fetched regardless, so the report shows what every source
// returns.
func (c *Client) innerTubeStages(ctx context.Context, videoID string, diag bool) ([]RadioStage, error) {
	clientCtx := map[string]any{
		"context": map[string]any{
			"client": map[string]any{
				"clientName":    clientName,
				"clientVersion": clientVer,
				"hl":            "en",
				"gl":            "US",
			},
		},
	}
	raw, err := c.postNext(ctx, mergeMaps(clientCtx, map[string]any{"videoId": videoID}))
	if err != nil {
		return nil, err
	}
	surfaces, err := parseNextSurfaces(raw)
	if err != nil {
		return nil, err
	}
	var stages []RadioStage
	for _, kind := range nextSurfaceOrder {
		if tracks := surfaces[kind]; len(tracks) > 0 {
			stages = append(stages, RadioStage{Kind: kind, Endpoint: "next(videoId " + videoID + ")", Tracks: tracks})
		}
	}
	if !diag && len(stages) > 0 && !NeedsBroaderSources(stages) {
		return stages, nil
	}

	// Nothing usable, or an artist-dominated answer: follow the autoplay
	// ("automix") preview continuation.
	var root any
	if err := json.Unmarshal(raw, &root); err != nil {
		return stages, fmt.Errorf("%w: malformed JSON", ErrProvider)
	}
	previews := []map[string]any{}
	collect(root, "automixPreviewVideoRenderer", &previews)
	for _, preview := range previews {
		token := continuationToken(preview)
		if token == "" {
			continue
		}
		next, err := c.postNext(ctx, mergeMaps(clientCtx, map[string]any{"continuation": token}))
		if err != nil {
			continue
		}
		mixSurfaces, err := parseNextSurfaces(next)
		if err != nil {
			continue
		}
		mixTracks := []model.Track{}
		for _, kind := range nextSurfaceOrder {
			mixTracks = append(mixTracks, mixSurfaces[kind]...)
		}
		if len(mixTracks) > 0 {
			stages = append(stages, RadioStage{Kind: "automix", Endpoint: "next(automix continuation)", Tracks: mixTracks})
			if !diag && !NeedsBroaderSources(stages) {
				return stages, nil
			}
			break
		}
	}

	// The song-radio playlist itself (RDAMVM<videoID> — what YouTube Music
	// plays for "Start radio"): a genuinely broader source when the queue is
	// artist-heavy, unlike artist text search.
	radio, rerr := c.postNext(ctx, mergeMaps(clientCtx, map[string]any{"playlistId": "RDAMVM" + videoID}))
	if rerr == nil {
		if radioSurfaces, perr := parseNextSurfaces(radio); perr == nil {
			radioTracks := []model.Track{}
			for _, kind := range nextSurfaceOrder {
				radioTracks = append(radioTracks, radioSurfaces[kind]...)
			}
			if len(radioTracks) > 0 {
				stages = append(stages, RadioStage{
					Kind:     "radio",
					Endpoint: "next(RDAMVM" + videoID + ")",
					Tracks:   radioTracks,
				})
			}
		}
	}
	return stages, nil
}

// NeedsBroaderSources reports whether the candidate stages fail the Song
// Radio rule as they stand (exported for the diagnostics tool, which mirrors
// the production stop point): nothing usable at all, the LEADING stage (the one
// that would define the top of the queue) is an artist wall, or the merged
// feed is artist-dominated. A mixed tail must not mask an artist-heavy lead.
func NeedsBroaderSources(stages []RadioStage) bool {
	if len(stages) == 0 {
		return true
	}
	if artistDominated(stages[0].Tracks) {
		return true
	}
	return artistDominated(flattenStages(stages))
}

// SelectRadioStages implements the Song Radio source rule. The stages are
// returned unchanged unless the rule is violated (see needsBroaderSources).
// In that case the artist-heavy stages must not define the radio: the first
// stage that is itself a genuinely mixed recommendation feed (>=6 rows, not
// artist-dominated, most distinct identities) is promoted to lead, and the
// remaining stages follow behind with their internal order untouched. If no
// stage is mixed, the order stands — YouTube offered nothing broader.
func SelectRadioStages(stages []RadioStage) []RadioStage {
	if len(stages) < 2 || !NeedsBroaderSources(stages) {
		return stages
	}
	best := -1
	bestDistinct := -1
	for i, s := range stages {
		if len(s.Tracks) < 6 || artistDominated(s.Tracks) {
			continue
		}
		if d := distinctIdentities(s.Tracks); d > bestDistinct {
			best, bestDistinct = i, d
		}
	}
	if best < 0 {
		return stages
	}
	out := make([]RadioStage, 0, len(stages))
	out = append(out, stages[best])
	for i, s := range stages {
		if i != best {
			out = append(out, s)
		}
	}
	return out
}

// stageResponse flattens stages (in order, deduped by video id) into one
// radio response. Shelves records each stage's deduped contribution in the
// final order, so provenance shows which source leads the radio.
func stageResponse(stages []RadioStage) model.RadioResponse {
	out := model.RadioResponse{Tracks: []model.Track{}}
	seen := map[string]bool{}
	for _, s := range stages {
		added := 0
		for _, t := range s.Tracks {
			if t.SourceID == "" || seen[t.SourceID] {
				continue
			}
			seen[t.SourceID] = true
			out.Tracks = append(out.Tracks, t)
			added++
		}
		if added > 0 {
			out.Shelves = append(out.Shelves, model.RadioShelf{Kind: s.Kind, Count: added})
			if out.Source == "" {
				out.Source = sourceForStage(s.Kind)
			}
		}
	}
	return out
}

func sourceForStage(kind string) string {
	if kind == "ytdlp-mix" {
		return "yt-dlp-mix"
	}
	return "ytmusic-next"
}

func flattenStages(stages []RadioStage) []model.Track {
	out := []model.Track{}
	seen := map[string]bool{}
	for _, s := range stages {
		for _, t := range s.Tracks {
			if t.SourceID == "" || seen[t.SourceID] {
				continue
			}
			seen[t.SourceID] = true
			out = append(out, t)
		}
	}
	return out
}

// distinctIdentities counts unique artist (or, absent that, uploader)
// identities in a feed.
func distinctIdentities(tracks []model.Track) int {
	ids := map[string]bool{}
	for _, t := range tracks {
		id := strings.ToLower(strings.TrimSpace(t.Artist))
		if id == "" {
			id = strings.ToLower(strings.TrimSpace(t.Uploader))
		}
		if id != "" {
			ids[id] = true
		}
	}
	return len(ids)
}

// artistDominated reports whether one artist/channel identity holds ≥60% of a
// feed of at least six tracks — the "every row is the same artist" shape that
// must trigger broader candidate generation instead of being accepted.
func artistDominated(tracks []model.Track) bool {
	if len(tracks) < 6 {
		return false
	}
	counts := map[string]int{}
	for _, t := range tracks {
		id := strings.ToLower(strings.TrimSpace(t.Artist))
		if id == "" {
			id = strings.ToLower(strings.TrimSpace(t.Uploader))
		}
		if id == "" {
			continue
		}
		counts[id]++
	}
	top := 0
	for _, n := range counts {
		if n > top {
			top = n
		}
	}
	return float64(top)/float64(len(tracks)) >= 0.6
}

// postNext performs one InnerTube /next request and returns the raw body.
func (c *Client) postNext(ctx context.Context, payload map[string]any) ([]byte, error) {
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.NextEndpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Origin", "https://music.youtube.com")
	req.Header.Set("Referer", "https://music.youtube.com/")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNetwork, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w (HTTP %d)", ErrProvider, resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 12<<20))
}

func mergeMaps(base map[string]any, extra map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(extra))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

// continuationToken finds the continuation command's token anywhere inside an
// autoplay preview renderer (YouTube nests it under an all-caps CONTINUATION
// key whose shape changes over time).
func continuationToken(v any) string {
	switch t := v.(type) {
	case map[string]any:
		if cmd, ok := t["continuationCommand"].(map[string]any); ok {
			if token, _ := cmd["token"].(string); token != "" {
				return token
			}
		}
		for _, v2 := range t {
			if token := continuationToken(v2); token != "" {
				return token
			}
		}
	case []any:
		for _, v2 := range t {
			if token := continuationToken(v2); token != "" {
				return token
			}
		}
	}
	return ""
}

// relatedYTDLP dumps the seed's YouTube mix (RD<videoID>) as a flat playlist.
func (c *Client) relatedYTDLP(ctx context.Context, videoID string) (model.RadioResponse, error) {
	if c.YTDLP == nil {
		return model.RadioResponse{}, ErrProvider
	}
	out, err := c.YTDLP.Run(ctx, "--dump-single-json", "--flat-playlist", "--no-warnings",
		"https://www.youtube.com/playlist?list=RD"+videoID)
	if err != nil {
		return model.RadioResponse{}, fmt.Errorf("%w: %v", ErrNetwork, err)
	}
	res, err := ParseYTDLPSearch(out, "")
	if err != nil {
		return model.RadioResponse{}, err
	}
	return model.RadioResponse{Tracks: res.Songs, Source: "yt-dlp-mix"}, nil
}

// ParseNextResponse walks an InnerTube /next payload defensively and collects
// candidates from EVERY recommendation surface of the watch-next page, not
// just the queue:
//
//   - "queue": playlistPanelVideoRenderer items — the "Up next" radio panel;
//   - "related-videos": compactVideoRenderer items — the regular YouTube
//     related feed that answers for uploads outside the music catalog
//     (slowed/fonk edits, remixes, BGM rips). Skipping these made such seeds
//     look "related-less" and dropped the radio into artist text search;
//   - "music-shelves": musicResponsiveListItemRenderer items with a watch
//     endpoint — the music shelves below the queue (related, mixes,
//     recommendations);
//   - "tiles": musicTwoRowItemRenderer video tiles.
//
// Queue items come first (their order is the provider's own relevance ranking
// for the radio); shelf items follow in document order. Items are deduped by
// videoId across surfaces. Identity rules follow e105a1f: browse-identified
// artists on music surfaces, "- Topic" channel promotion everywhere, and bare
// channel names on video surfaces stay uploader metadata — never artists.
func ParseNextResponse(raw []byte) (model.RadioResponse, error) {
	surfaces, err := parseNextSurfaces(raw)
	if err != nil {
		return model.RadioResponse{}, err
	}
	out := model.RadioResponse{Source: "ytmusic-next", Tracks: []model.Track{}}
	for _, kind := range nextSurfaceOrder {
		for _, t := range surfaces[kind] {
			out.Tracks = append(out.Tracks, t)
		}
		if n := len(surfaces[kind]); n > 0 {
			out.Shelves = append(out.Shelves, model.RadioShelf{Kind: kind, Count: n})
		}
	}
	return out, nil
}

// nextSurfaceOrder is the candidate priority across the surfaces of ONE
// /next response: the provider's own radio queue first, then the regular
// related feed, then music shelves and tiles.
var nextSurfaceOrder = []string{"queue", "related-videos", "music-shelves", "tiles"}

// parseNextSurfaces splits a /next payload into its independent
// recommendation surfaces. Every row records its renderer (Track.Via) and
// where the Artist value came from (Track.ArtistSrc) so diagnostics can tell
// "YouTube Music identified this artist" apart from "this row only has a
// channel name".
func parseNextSurfaces(raw []byte) (map[string][]model.Track, error) {
	var root any
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil, fmt.Errorf("%w: malformed JSON", ErrProvider)
	}
	surfaces := map[string][]model.Track{}
	seen := map[string]bool{}
	add := func(kind string, t model.Track, ok bool) {
		if !ok || t.SourceID == "" || t.Title == "" || seen[t.SourceID] {
			return
		}
		seen[t.SourceID] = true
		t.Via = rendererForSurface[kind]
		surfaces[kind] = append(surfaces[kind], t)
	}

	queue := []map[string]any{}
	collect(root, "playlistPanelVideoRenderer", &queue)
	for _, it := range queue {
		add("queue", trackFromPanel(it), true)
	}
	compact := []map[string]any{}
	collect(root, "compactVideoRenderer", &compact)
	for _, it := range compact {
		if t, ok := trackFromCompactVideo(it); ok {
			add("related-videos", t, true)
		}
	}
	listItems := []map[string]any{}
	collect(root, "musicResponsiveListItemRenderer", &listItems)
	for _, it := range listItems {
		if t, ok := trackFromWatchListItem(it); ok {
			add("music-shelves", t, true)
		}
	}
	tiles := []map[string]any{}
	collect(root, "musicTwoRowItemRenderer", &tiles)
	for _, it := range tiles {
		if t, ok := trackFromTile(it); ok {
			add("tiles", t, true)
		}
	}
	return surfaces, nil
}

var rendererForSurface = map[string]string{
	"queue":          "playlistPanelVideoRenderer",
	"related-videos": "compactVideoRenderer",
	"music-shelves":  "musicResponsiveListItemRenderer",
	"tiles":          "musicTwoRowItemRenderer",
}

// trackFromPanel builds a track from a queue panel item (the previous,
// panel-only parser, unchanged in behaviour).
func trackFromPanel(it map[string]any) model.Track {
	videoID := firstString(it, "videoId")
	titleRuns := runsOfValue(it["title"])
	t := model.Track{
		ID:       "yt:" + videoID,
		SourceID: videoID,
		Source:   "youtube",
		URL:      "https://music.youtube.com/watch?v=" + videoID,
		Artwork:  bestThumbnail(it),
		Explicit: hasExplicitBadge(it),
	}
	if len(titleRuns) > 0 {
		t.Title = titleRuns[0].Text
	}
	if length := panelLength(it); length > 0 {
		t.Duration = length
	}
	byline := panelBylineRuns(it)
	var artistParts []string
	var channel string
	for _, r := range byline {
		switch {
		case durationRe.MatchString(r.Text):
			if t.Duration == 0 {
				t.Duration = parseClock(r.Text)
			}
		case strings.HasPrefix(r.BrowseID, "MPRE"):
			if t.Album == "" {
				t.Album = r.Text
				t.AlbumBrowseID = r.BrowseID
			}
		case strings.HasPrefix(r.BrowseID, "UC"):
			// A browse endpoint into an artist channel is the provider
			// explicitly identifying the performing artist. (Diagnostics
			// record the raw id: personal channel pages also carry UC ids,
			// which is exactly what the seed-echo mis-identification
			// surfaced.)
			artistParts = append(artistParts, r.Text)
			t.ArtistSrc = "browse"
			if t.ArtistBrowseID == "" {
				t.ArtistBrowseID = r.BrowseID
			}
		}
	}
	if len(artistParts) == 0 {
		// Video-style panels carry a bare channel/uploader name. It is NOT
		// the performing artist unless the channel is an official
		// "<Artist> - Topic" artist channel.
		for _, r := range byline {
			if isTypeLabel(r.Text) || durationRe.MatchString(r.Text) || viewsRe.MatchString(r.Text) {
				continue
			}
			channel = r.Text
			t.UploaderChannelID = r.BrowseID
			break
		}
		if artist, ok := artistFromChannel(channel); ok {
			artistParts = append(artistParts, artist)
			t.ArtistSrc = "topic"
		}
	}
	t.Artist = strings.Join(uniqueStrings(artistParts), ", ")
	t.Uploader = channel
	return t
}

// trackFromCompactVideo builds a track from a regular YouTube related-video
// row. These answer for uploads outside the music catalog (slowed edits,
// remixes): their byline is the uploading CHANNEL, so it is kept as uploader
// metadata and only an official "<Artist> - Topic" channel is promoted to an
// artist — a channel name is never musical identity.
func trackFromCompactVideo(it map[string]any) (model.Track, bool) {
	videoID := firstString(it, "videoId")
	if videoID == "" {
		return model.Track{}, false
	}
	t := model.Track{
		ID:       "yt:" + videoID,
		SourceID: videoID,
		Source:   "youtube",
		URL:      "https://music.youtube.com/watch?v=" + videoID,
		Artwork:  bestThumbnail(it),
	}
	titleRuns := runsOfValue(it["title"])
	if len(titleRuns) == 0 || titleRuns[0].Text == "" {
		return model.Track{}, false
	}
	t.Title = titleRuns[0].Text
	if length := simpleOrRunsLength(it["lengthText"]); length > 0 {
		t.Duration = length
	}
	byline := panelBylineRuns(it)
	channel := ""
	channelID := ""
	for _, r := range byline {
		if isTypeLabel(r.Text) || durationRe.MatchString(r.Text) || viewsRe.MatchString(r.Text) {
			continue
		}
		channel = r.Text
		channelID = r.BrowseID
		break
	}
	t.UploaderChannelID = channelID
	if artist, ok := artistFromChannel(channel); ok {
		t.Artist = artist
		t.ArtistSrc = "topic"
		t.ArtistBrowseID = channelID
	}
	t.Uploader = channel
	return t, true
}

// trackFromWatchListItem builds a track from a music-shelf row of the
// watch-next page (related/recommendation shelves). Only rows that actually
// watch a video become candidates; album/artist browse rows are skipped.
// Identity follows the music-search rules: browse-identified artists are
// artists, bare channels stay uploaders unless "- Topic".
func trackFromWatchListItem(it map[string]any) (model.Track, bool) {
	videoID := watchVideoID(it)
	if videoID == "" {
		return model.Track{}, false
	}
	title, runs := columns(it)
	if title == "" {
		return model.Track{}, false
	}
	t := model.Track{
		ID:       "yt:" + videoID,
		SourceID: videoID,
		Source:   "youtube",
		URL:      "https://music.youtube.com/watch?v=" + videoID,
		Title:    title,
		Artwork:  bestThumbnail(it),
		Explicit: hasExplicitBadge(it),
	}
	var artistParts []string
	var channel string
	for _, r := range runs {
		switch {
		case durationRe.MatchString(r.Text):
			if t.Duration == 0 {
				t.Duration = parseClock(r.Text)
			}
		case strings.HasPrefix(r.BrowseID, "MPRE"):
			if t.Album == "" {
				t.Album = r.Text
				t.AlbumBrowseID = r.BrowseID
			}
		case strings.HasPrefix(r.BrowseID, "UC"):
			artistParts = append(artistParts, r.Text)
			t.ArtistSrc = "browse"
			if t.ArtistBrowseID == "" {
				t.ArtistBrowseID = r.BrowseID
			}
		}
	}
	if len(artistParts) == 0 {
		for _, r := range runs {
			if isTypeLabel(r.Text) || durationRe.MatchString(r.Text) || viewsRe.MatchString(r.Text) {
				continue
			}
			channel = r.Text
			t.UploaderChannelID = r.BrowseID
			break
		}
		if artist, ok := artistFromChannel(channel); ok {
			artistParts = append(artistParts, artist)
			t.ArtistSrc = "topic"
		}
	}
	t.Artist = strings.Join(uniqueStrings(artistParts), ", ")
	t.Uploader = channel
	return t, true
}

// trackFromTile builds a track from a musicTwoRowItemRenderer video tile
// (shelf entries like "Related tracks"). Tiles without a video watch endpoint
// (albums, artists, playlists) are skipped. The subtitle is a channel byline:
// uploader metadata unless it is an official "- Topic" artist channel.
func trackFromTile(it map[string]any) (model.Track, bool) {
	videoID := watchVideoID(it)
	if videoID == "" {
		return model.Track{}, false
	}
	titleRuns := runsOfValue(it["title"])
	if len(titleRuns) == 0 || titleRuns[0].Text == "" {
		return model.Track{}, false
	}
	t := model.Track{
		ID:       "yt:" + videoID,
		SourceID: videoID,
		Source:   "youtube",
		URL:      "https://music.youtube.com/watch?v=" + videoID,
		Title:    titleRuns[0].Text,
		Artwork:  bestThumbnail(it),
	}
	subtitle := runsOfValue(it["subtitle"])
	channel := ""
	for _, r := range subtitle {
		if isTypeLabel(r.Text) || durationRe.MatchString(r.Text) || viewsRe.MatchString(r.Text) {
			continue
		}
		if channel == "" {
			channel = r.Text
			t.UploaderChannelID = r.BrowseID
			continue
		}
		if t.Album == "" && !strings.Contains(r.Text, "view") && !strings.Contains(r.Text, "subscriber") {
			t.Album = r.Text
			t.AlbumBrowseID = r.BrowseID
		}
		break
	}
	if artist, ok := artistFromChannel(channel); ok {
		t.Artist = artist
		t.ArtistSrc = "topic"
		t.ArtistBrowseID = t.UploaderChannelID
	}
	t.Uploader = channel
	return t, true
}

// watchVideoID finds the video a list item or tile actually plays: the
// top-level videoId, or the first watchEndpoint.videoId in its navigation /
// overlay endpoints.
func watchVideoID(item map[string]any) string {
	if id := firstString(item, "videoId"); id != "" {
		return id
	}
	for _, key := range []string{"navigationEndpoint", "overlay", "menu"} {
		var endpoint string
		findWatchVideoID(item[key], &endpoint)
		if endpoint != "" {
			return endpoint
		}
	}
	return ""
}

func findWatchVideoID(v any, out *string) {
	if *out != "" {
		return
	}
	switch t := v.(type) {
	case map[string]any:
		if watch, ok := t["watchEndpoint"].(map[string]any); ok {
			if id, _ := watch["videoId"].(string); id != "" {
				*out = id
				return
			}
		}
		for _, v2 := range t {
			findWatchVideoID(v2, out)
		}
	case []any:
		for _, v2 := range t {
			findWatchVideoID(v2, out)
		}
	}
}

// simpleOrRunsLength reads a lengthText that may be a plain string or runs.
func simpleOrRunsLength(v any) float64 {
	if m, ok := v.(map[string]any); ok {
		if s, _ := m["simpleText"].(string); s != "" && durationRe.MatchString(s) {
			return parseClock(s)
		}
		for _, r := range runsOfValue(v) {
			if durationRe.MatchString(r.Text) {
				return parseClock(r.Text)
			}
		}
	}
	return 0
}

// panelBylineRuns returns the "Artist • Album • duration" runs of a watch-next
// panel item, preferring the long byline.
func panelBylineRuns(item map[string]any) []run {
	if rs := runsOfValue(item["longBylineText"]); len(rs) > 0 {
		return rs
	}
	return runsOfValue(item["shortBylineText"])
}

func panelLength(item map[string]any) float64 {
	rs := runsOfValue(item["lengthText"])
	for _, r := range rs {
		if durationRe.MatchString(r.Text) {
			return parseClock(r.Text)
		}
	}
	return 0
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
		channel := firstNonEmpty(e.Uploader, e.Channel)
		artist := strings.TrimSpace(e.Artist)
		if artist == "" {
			// yt-dlp's uploader/channel is NOT the performing artist unless it
			// is an official "<Artist> - Topic" artist channel.
			if a, ok := artistFromChannel(channel); ok {
				artist = a
			}
		}
		t := TrackFromYTDLP(e.ID, e.Title, artist, e.Album, bestEntryThumb(e), e.Duration)
		t.Uploader = channel
		res.Songs = append(res.Songs, t)
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
	// The artist here comes from yt-dlp's own metadata extraction (catalog
	// data), never from the channel name — recorded so diagnostics can tell
	// them apart on real responses.
	t := model.Track{
		ID:       "yt:" + id,
		SourceID: id,
		Source:   "youtube",
		URL:      "https://www.youtube.com/watch?v=" + id,
		Title:    strings.TrimSpace(title),
		Artist:   strings.TrimSpace(artist),
		Album:    strings.TrimSpace(album),
		Artwork:  artwork,
		Duration: duration,
		Via:      "ytdlp-mix",
	}
	if t.Artist != "" {
		t.ArtistSrc = "metadata"
	}
	return t
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
