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
					t.Album = r.Text
				case strings.HasPrefix(r.BrowseID, "UC"):
					artistParts = append(artistParts, r.Text)
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
					break
				}
				if artist, ok := artistFromChannel(channel); ok {
					artistParts = append(artistParts, artist)
				}
			}
			t.Artist = strings.Join(uniqueStrings(artistParts), ", ")
			t.Uploader = channel
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
func (c *Client) Related(ctx context.Context, videoID string) (model.RadioResponse, error) {
	videoID = strings.TrimSpace(videoID)
	if videoID == "" {
		return model.RadioResponse{}, nil
	}
	res, err := c.relatedInnerTube(ctx, videoID)
	if err == nil && len(res.Tracks) > 0 {
		return res, nil
	}
	fallback, ferr := c.relatedYTDLP(ctx, videoID)
	if ferr == nil && len(fallback.Tracks) > 0 {
		return fallback, nil
	}
	if err != nil {
		return model.RadioResponse{}, err
	}
	if ferr != nil {
		return model.RadioResponse{}, ferr
	}
	return res, nil
}

// relatedInnerTube asks the YouTube Music watch-next endpoint for the "Up
// next" queue of a video. For most uploads the first response only contains an
// autoplay *preview* (automixPreviewVideoRenderer); the actual recommendation
// queue is then one continuation request away — exactly the request YouTube
// Music itself makes. Without following it, tracks with no explicit radio
// panel would appear to have no related data and callers would fall back to
// text search, which is how unrelated songs used to leak into autoplay.
func (c *Client) relatedInnerTube(ctx context.Context, videoID string) (model.RadioResponse, error) {
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
		return model.RadioResponse{}, err
	}
	parsed, err := ParseNextResponse(raw)
	if err != nil {
		return model.RadioResponse{}, err
	}
	if len(parsed.Tracks) > 0 && !artistDominated(parsed.Tracks) {
		return parsed, nil
	}

	// No usable queue (or an artist-dominated one): follow the autoplay
	// ("automix") preview continuation — exactly the request YouTube Music
	// itself makes to expand the radio.
	var root any
	if err := json.Unmarshal(raw, &root); err != nil {
		return model.RadioResponse{}, fmt.Errorf("%w: malformed JSON", ErrProvider)
	}
	previews := []map[string]any{}
	collect(root, "automixPreviewVideoRenderer", &previews)
	base := parsed
	for _, preview := range previews {
		token := continuationToken(preview)
		if token == "" {
			continue
		}
		next, err := c.postNext(ctx, mergeMaps(clientCtx, map[string]any{"continuation": token}))
		if err != nil {
			continue
		}
		mix, err := ParseNextResponse(next)
		if err != nil {
			continue
		}
		if len(mix.Tracks) > 0 {
			base = mergeRadio(base, mix, "automix")
			if !artistDominated(base.Tracks) {
				return base, nil
			}
			break
		}
	}

	// The last real recommendation surface: the song-radio playlist itself
	// (RDAMVM<videoID> — what YouTube Music plays for "Start radio"). Used
	// when nothing above answered OR when the feed is artist-dominated: a
	// queue that is >60% one artist is not a radio batch, and this playlist
	// is a genuinely broader source, unlike artist text search.
	radio, err := c.postNext(ctx, mergeMaps(clientCtx, map[string]any{"playlistId": "RDAMVM" + videoID}))
	if err != nil {
		if len(base.Tracks) > 0 {
			return base, nil
		}
		return model.RadioResponse{}, err
	}
	radioParsed, err := ParseNextResponse(radio)
	if err != nil || len(radioParsed.Tracks) == 0 {
		if len(base.Tracks) > 0 {
			return base, nil
		}
		if err != nil {
			return model.RadioResponse{}, err
		}
		return radioParsed, nil
	}
	merged := mergeRadio(base, radioParsed, "radio")
	if len(merged.Tracks) == 0 {
		return radioParsed, nil
	}
	return merged, nil
}

// mergeRadio merges a secondary surface's candidates into a base response,
// keeping the base's order first and appending only unseen videos.
func mergeRadio(base, extra model.RadioResponse, stage string) model.RadioResponse {
	if len(extra.Tracks) == 0 {
		return base
	}
	seen := map[string]bool{}
	for _, t := range base.Tracks {
		seen[t.SourceID] = true
	}
	out := model.RadioResponse{
		Source:  base.Source,
		Tracks:  append([]model.Track{}, base.Tracks...),
		Shelves: append([]model.RadioShelf{}, base.Shelves...),
	}
	added := 0
	for _, t := range extra.Tracks {
		if seen[t.SourceID] {
			continue
		}
		seen[t.SourceID] = true
		out.Tracks = append(out.Tracks, t)
		added++
	}
	if added > 0 {
		out.Shelves = append(out.Shelves, model.RadioShelf{Kind: stage, Count: added})
	}
	return out
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
	var root any
	if err := json.Unmarshal(raw, &root); err != nil {
		return model.RadioResponse{}, fmt.Errorf("%w: malformed JSON", ErrProvider)
	}
	out := model.RadioResponse{Source: "ytmusic-next", Tracks: []model.Track{}}
	seen := map[string]bool{}
	add := func(t model.Track, ok bool) bool {
		if !ok || t.SourceID == "" || t.Title == "" || seen[t.SourceID] {
			return false
		}
		seen[t.SourceID] = true
		out.Tracks = append(out.Tracks, t)
		return true
	}

	queue := []map[string]any{}
	collect(root, "playlistPanelVideoRenderer", &queue)
	panels := 0
	for _, it := range queue {
		if add(trackFromPanel(it), true) {
			panels++
		}
	}
	compact := []map[string]any{}
	collect(root, "compactVideoRenderer", &compact)
	compactCount := 0
	for _, it := range compact {
		if add(trackFromCompactVideo(it)) {
			compactCount++
		}
	}
	listItems := []map[string]any{}
	collect(root, "musicResponsiveListItemRenderer", &listItems)
	shelfCount := 0
	for _, it := range listItems {
		if add(trackFromWatchListItem(it)) {
			shelfCount++
		}
	}
	tiles := []map[string]any{}
	collect(root, "musicTwoRowItemRenderer", &tiles)
	tileCount := 0
	for _, it := range tiles {
		if add(trackFromTile(it)) {
			tileCount++
		}
	}
	for _, sh := range []struct {
		kind  string
		count int
	}{{"queue", panels}, {"related-videos", compactCount}, {"music-shelves", shelfCount}, {"tiles", tileCount}} {
		if sh.count > 0 {
			out.Shelves = append(out.Shelves, model.RadioShelf{Kind: sh.kind, Count: sh.count})
		}
	}
	return out, nil
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
			}
		case strings.HasPrefix(r.BrowseID, "UC"):
			// A browse endpoint into an artist channel is the provider
			// explicitly identifying the performing artist.
			artistParts = append(artistParts, r.Text)
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
			break
		}
		if artist, ok := artistFromChannel(channel); ok {
			artistParts = append(artistParts, artist)
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
	for _, r := range byline {
		if isTypeLabel(r.Text) || durationRe.MatchString(r.Text) || viewsRe.MatchString(r.Text) {
			continue
		}
		channel = r.Text
		break
	}
	if artist, ok := artistFromChannel(channel); ok {
		t.Artist = artist
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
			}
		case strings.HasPrefix(r.BrowseID, "UC"):
			artistParts = append(artistParts, r.Text)
		}
	}
	if len(artistParts) == 0 {
		for _, r := range runs {
			if isTypeLabel(r.Text) || durationRe.MatchString(r.Text) || viewsRe.MatchString(r.Text) {
				continue
			}
			channel = r.Text
			break
		}
		if artist, ok := artistFromChannel(channel); ok {
			artistParts = append(artistParts, artist)
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
			continue
		}
		if t.Album == "" && !strings.Contains(r.Text, "view") && !strings.Contains(r.Text, "subscriber") {
			t.Album = r.Text
		}
		break
	}
	if artist, ok := artistFromChannel(channel); ok {
		t.Artist = artist
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
