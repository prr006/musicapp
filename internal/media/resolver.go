// Package media turns a Track into something the webview's media element can
// actually play. It has two halves:
//
//	Resolver — asks yt-dlp for the full format list of a source id, picks the
//	           most suitable stream itself, and caches the answer until the CDN
//	           URL expires.
//	Proxy    — a loopback HTTP server that streams that URL to the media
//	           element with byte-range support, so seeking works and the
//	           provider's headers/CORS never reach the renderer.
//
// The resolver is deliberately independent from playback: it knows about
// YouTube, the player does not.
//
// Why the resolver picks formats itself: yt-dlp is invoked with
// --dump-single-json (no -f). Even so, yt-dlp runs its own *default* format
// selection ("best/bestvideo+bestaudio", or "bestvideo*+bestaudio/best" when
// ffmpeg is present) before dumping the JSON, and aborts with "Requested format
// is not available" when that selection can't match a video — which happens for
// audio-only uploads, PO-token-gated formats, and videos that only expose
// manifest streams. We pass --ignore-no-formats-error so yt-dlp always returns
// the full format list, and ParseResolved below makes the playable choice.
package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ErrResolve     = errors.New("couldn't load this song")
	ErrNoAudio     = errors.New("this song has no playable audio stream")
	ErrUnavailable = errors.New("media unavailable")
)

// ---- temporary diagnostics (MELO_RESOLVER_DIAG=1) ----
//
// These record, for a single failing video, every format yt-dlp returned and
// why the picker accepted or rejected it. They exist only to capture the real
// Windows failing case and are silent unless the env var is set. Remove this
// block once the root cause is pinned down.

var (
	diagOnce   sync.Once
	diagWriter io.Writer
	diagPath   string
	diagErr    error
)

func diagEnabled() bool {
	return os.Getenv("MELO_RESOLVER_DIAG") != ""
}

// ensureDiag opens (creating it if needed) the resolver diagnostic log exactly
// once. Any setup failure is recorded in diagErr and surfaced — never silently
// swallowed — so a bad path or permission problem is visible instead of looking
// like the feature simply isn't there.
func ensureDiag() (string, bool) {
	diagOnce.Do(func() {
		if !diagEnabled() {
			diagErr = errors.New("MELO_RESOLVER_DIAG is not set")
			return
		}
		dir, err := os.UserConfigDir()
		if err != nil {
			diagErr = fmt.Errorf("cannot locate the config directory: %w", err)
			return
		}
		logDir := filepath.Join(dir, "MELO")
		if err := os.MkdirAll(logDir, 0o755); err != nil {
			diagErr = fmt.Errorf("cannot create %s: %w", logDir, err)
			return
		}
		path := filepath.Join(logDir, "resolver-diag.log")
		f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			diagErr = fmt.Errorf("cannot open %s: %w", path, err)
			return
		}
		diagWriter, diagPath, diagErr = f, path, nil
	})
	if diagErr != nil {
		return "", false
	}
	return diagPath, true
}

// InitDiag is called once at startup. When MELO_RESOLVER_DIAG is set it prints
// a line to stderr stating exactly where the log will be written (or why it
// cannot be), so a missing env var or a bad path is immediately visible in the
// `wails dev` console instead of silently producing nothing.
func InitDiag() {
	if !diagEnabled() {
		return
	}
	path, ok := ensureDiag()
	if !ok {
		fmt.Fprintf(os.Stderr, "melo: resolver diagnostics DISABLED: %v\n", diagErr)
		return
	}
	fmt.Fprintf(os.Stderr, "melo: resolver diagnostics ENABLED, log=%s\n", path)
	diagf("resolver diagnostics ENABLED (MELO_RESOLVER_DIAG=%q), log=%s", os.Getenv("MELO_RESOLVER_DIAG"), path)
}

func diagf(format string, args ...any) {
	if !diagEnabled() {
		return
	}
	if _, ok := ensureDiag(); !ok {
		fmt.Fprintf(os.Stderr, "melo: resolver diag write failed: %v\n", diagErr)
		return
	}
	fmt.Fprintf(diagWriter, "[%s] %s\n", time.Now().Format(time.RFC3339), fmt.Sprintf(format, args...))
}

func truncateForDiag(raw []byte) string {
	const max = 12000
	if len(raw) <= max {
		return string(raw)
	}
	return string(raw[:max]) + "\n… [truncated]"
}

type Runner interface {
	Run(ctx context.Context, args ...string) ([]byte, error)
}

// Resolved is the raw upstream stream description (internal to Go).
type Resolved struct {
	SourceID  string
	URL       string
	MimeType  string
	Duration  float64
	Bitrate   int
	Filesize  int64
	ExpiresAt time.Time
	Headers   map[string]string
	Title     string
	Artist    string
	Album     string
	Artwork   string
}

func (r Resolved) Expired(now time.Time) bool {
	return !r.ExpiresAt.IsZero() && now.After(r.ExpiresAt.Add(-30*time.Second))
}

type Resolver struct {
	runner Runner
	// ExtraArgs, when set, are appended to every yt-dlp invocation. It exists
	// for tools/playbench to A/B candidate extractor arguments against the
	// production set through the REAL pipeline (same cache, dedupe and format
	// picking). Nil in the app — production behavior is byte-identical.
	ExtraArgs []string
	// probeOnce kicks off a BACKGROUND `yt-dlp --version` timing the first
	// time a resolution runs with latency diagnostics enabled. That measures
	// the pure spawn+interpreter+import cost of the binary on THIS machine —
	// subtracting it from a resolve attempt separates process overhead from
	// extraction/network work. It is fire-and-forget: a probe must never delay
	// a resolution (it would slow down the exact click being diagnosed), so it
	// runs on its own goroutine and logs whenever it completes. Never runs at
	// all when diagnostics are off.
	probeOnce sync.Once
	mu        sync.Mutex
	cache     map[string]Resolved
	// order preserves insertion order so the cache stays bounded (FIFO
	// eviction of the oldest resolution when cacheMax is exceeded).
	order  []string
	inWork map[string]*call
	now    func() time.Time
}

// cacheMax bounds the resolved-source cache. Entries are small (one CDN URL
// plus stream facts) and self-expire with the CDN URL; the bound exists so a
// very long listening session cannot grow the map without limit.
const cacheMax = 32

type call struct {
	done chan struct{}
	res  Resolved
	err  error
}

func NewResolver(r Runner) *Resolver {
	return &Resolver{
		runner: r,
		cache:  map[string]Resolved{},
		inWork: map[string]*call{},
		now:    time.Now,
	}
}

// latencyLog prints click-to-play path diagnostics. Like MELO_RADIO_DEBUG and
// MELO_RESOLVER_DIAG, it is opt-in via an env var and completely silent in
// normal operation. The lines are keyed "[play-latency]" so a slow stage can
// be identified at a glance:
//
//	[play-latency] RESOLVE_START id=abc quality=high
//	[play-latency] RESOLVE_END id=abc elapsed=3.2s attempts=1 outcome=miss
func latencyLog(format string, args ...any) {
	if os.Getenv("MELO_PLAY_LATENCY") == "" {
		return
	}
	log.Printf("[play-latency] "+format, args...)
}

// trimLocked bounds both the cache and its order slice. Called with r.mu held.
func (r *Resolver) trimLocked() {
	for len(r.order) > 0 && (len(r.cache) > cacheMax || len(r.order) > 2*cacheMax) {
		k := r.order[0]
		r.order = r.order[1:]
		delete(r.cache, k)
	}
}

// Resolve returns a playable upstream URL for sourceID. Concurrent callers for
// the same key share one yt-dlp invocation; results are cached until expiry.
func (r *Resolver) Resolve(ctx context.Context, sourceID, quality string) (Resolved, error) {
	if strings.TrimSpace(sourceID) == "" {
		return Resolved{}, ErrResolve
	}
	key := sourceID + "|" + quality

	if os.Getenv("MELO_PLAY_LATENCY") != "" {
		r.probeOnce.Do(func() {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				start := time.Now()
				out, err := r.runner.Run(ctx, "--version")
				elapsed := time.Since(start)
				if err != nil {
					latencyLog("VERSION_PROBE failed after %s err=%v", elapsed.Round(time.Millisecond), err)
					return
				}
				latencyLog("VERSION_PROBE elapsed=%s version=%q (background spawn+interpreter+import cost; subtract from ATTEMPT to isolate extraction+network)", elapsed.Round(time.Millisecond), strings.TrimSpace(string(out)))
			}()
		})
	}

	r.mu.Lock()
	if hit, ok := r.cache[key]; ok && !hit.Expired(r.now()) {
		r.mu.Unlock()
		latencyLog("RESOLVE_HIT id=%s quality=%s expires_in=%s", sourceID, quality, time.Until(hit.ExpiresAt).Round(time.Second))
		return hit, nil
	}
	if c, ok := r.inWork[key]; ok {
		r.mu.Unlock()
		latencyLog("RESOLVE_SHARED id=%s quality=%s (joining in-flight resolution)", sourceID, quality)
		select {
		case <-c.done:
			return c.res, c.err
		case <-ctx.Done():
			return Resolved{}, ctx.Err()
		}
	}
	c := &call{done: make(chan struct{})}
	r.inWork[key] = c
	r.mu.Unlock()

	start := time.Now()
	latencyLog("RESOLVE_START id=%s quality=%s", sourceID, quality)
	c.res, c.err = r.fetch(ctx, sourceID, quality)
	close(c.done)

	r.mu.Lock()
	delete(r.inWork, key)
	if c.err == nil {
		if i := indexOf(r.order, key); i >= 0 {
			r.order = append(r.order[:i], r.order[i+1:]...)
		}
		r.order = append(r.order, key)
		r.cache[key] = c.res
		r.trimLocked()
	}
	r.mu.Unlock()
	latencyLog("RESOLVE_END id=%s elapsed=%s outcome=%s", sourceID, time.Since(start).Round(time.Millisecond), outcome(c.err))
	return c.res, c.err
}

func indexOf(vals []string, want string) int {
	for i, v := range vals {
		if v == want {
			return i
		}
	}
	return -1
}

func outcome(err error) string {
	if err == nil {
		return "resolved"
	}
	return "error: " + firstLine(err.Error())
}

// Invalidate drops a cached resolution (used when a stream 403s mid-playback).
func (r *Resolver) Invalidate(sourceID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for k := range r.cache {
		if strings.HasPrefix(k, sourceID+"|") {
			delete(r.cache, k)
		}
	}
}

// resolveClients is the ordered, bounded set of YouTube player-client
// configurations the resolver tries, in order, until one yields a browser-
// playable stream. It exists because yt-dlp 2026.08.19 gates media formats
// behind a GVS PO token for most clients:
//
//   - web, web_safari, web_music, web_creator, mweb: HTTPS/DASH require a PO
//     token; unauthenticated and without a PO-token provider they return only
//     storyboard (mhtml) formats.
//   - android, android_vr, ios: HTTPS requires a PO token or a player token.
//   - visionos, web_embedded, tv, tv_downgraded: no PO-token requirement.
//
// MELO is unauthenticated, ships no PO-token provider and no JS runtime, so the
// only reliable PO-token-free *and* JS-free client is visionos — which is
// exactly why yt-dlp's own unauthenticated default is "visionos,web". The
// second entry is the PO-token-free fallback for videos visionos cannot serve
// (e.g. made-for-kids).
var resolveClients = []string{
	"visionos,web",
	"web_embedded,tv_downgraded",
}

func (r *Resolver) fetch(ctx context.Context, sourceID, quality string) (Resolved, error) {
	// Bounded, deterministic fallback across client sets: try each in order and
	// stop at the first that produces a browser-playable stream. Only
	// "no playable stream" advances to the next set; real failures (network,
	// unavailable, unreadable output) are returned immediately and never masked.
	var lastErr error
	for i, clients := range resolveClients {
		args := []string{
			"--dump-single-json", "--no-playlist", "--no-warnings",
			"--ignore-no-formats-error",
			"--extractor-args", "youtube:player_client=" + clients,
			"https://www.youtube.com/watch?v=" + sourceID,
		}
		args = append(args, r.ExtraArgs...)
		diagf("resolve %s: attempt %d/%d yt-dlp %v", sourceID, i+1, len(resolveClients), args)
		attemptStart := time.Now()
		out, err := r.runner.Run(ctx, args...)
		latencyLog("ATTEMPT id=%s %d/%d clients=%s elapsed=%s", sourceID, i+1, len(resolveClients), clients, time.Since(attemptStart).Round(time.Millisecond))
		if err != nil {
			diagf("resolve %s: yt-dlp exited with error: %s", sourceID, err.Error())
			msg := strings.ToLower(err.Error())
			switch {
			case strings.Contains(msg, "private") || strings.Contains(msg, "unavailable") ||
				strings.Contains(msg, "removed") || strings.Contains(msg, "age"):
				return Resolved{}, fmt.Errorf("%w: %s", ErrUnavailable, firstLine(err.Error()))
			case strings.Contains(msg, "requested format is not available") || strings.Contains(msg, "no video formats"):
				// This client set exposed no downloadable formats; try the next.
				lastErr = fmt.Errorf("%w: %s", ErrNoAudio, firstLine(err.Error()))
				continue
			case strings.Contains(msg, "resolve host") || strings.Contains(msg, "network") ||
				strings.Contains(msg, "timed out") || strings.Contains(msg, "urlopen"):
				return Resolved{}, fmt.Errorf("couldn't reach YouTube: %s", firstLine(err.Error()))
			}
			return Resolved{}, fmt.Errorf("%w: %s", ErrResolve, firstLine(err.Error()))
		}
		parseStart := time.Now()
		res, perr := ParseResolved(out, sourceID, quality)
		if parse := time.Since(parseStart); parse > 50*time.Millisecond {
			// Parsing is expected to be negligible (<tens of ms). If it ever
			// is not, it shows up explicitly instead of hiding in the attempt.
			latencyLog("PARSE id=%s elapsed=%s jsonKB=%d", sourceID, parse.Round(time.Millisecond), len(out)/1024)
		}
		if perr == nil {
			return res, nil
		}
		if !errors.Is(perr, ErrNoAudio) {
			// A real failure (unavailable, live, unreadable output), not a lack
			// of formats — surface it rather than retrying with another client.
			return Resolved{}, perr
		}
		lastErr = perr
		diagf("resolve %s: attempt %d/%d had no playable stream; trying the next client set", sourceID, i+1, len(resolveClients))
	}
	if lastErr != nil {
		return Resolved{}, lastErr
	}
	return Resolved{}, ErrNoAudio
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i > 0 {
		return strings.TrimSpace(s[:i])
	}
	return strings.TrimSpace(s)
}

type ytFormat struct {
	FormatID    string            `json:"format_id"`
	URL         string            `json:"url"`
	Ext         string            `json:"ext"`
	ACodec      string            `json:"acodec"`
	VCodec      string            `json:"vcodec"`
	ABR         float64           `json:"abr"`
	TBR         float64           `json:"tbr"`
	Filesize    int64             `json:"filesize"`
	FilesizeAp  int64             `json:"filesize_approx"`
	Protocol    string            `json:"protocol"`
	HTTPHeaders map[string]string `json:"http_headers"`
	AudioExt    string            `json:"audio_ext"`
}

type ytInfo struct {
	ID        string     `json:"id"`
	Title     string     `json:"title"`
	Artist    string     `json:"artist"`
	Track     string     `json:"track"`
	Album     string     `json:"album"`
	Uploader  string     `json:"uploader"`
	Channel   string     `json:"channel"`
	Duration  float64    `json:"duration"`
	Thumbnail string     `json:"thumbnail"`
	Formats   []ytFormat `json:"formats"`
	IsLive    bool       `json:"is_live"`
}

// ParseResolved picks the best playable stream for the requested quality tier
// from yt-dlp JSON.
//
// Selection is adaptive: it never assumes a video exposes a particular format
// id or codec. It prefers an audio-only progressive stream (the app never needs
// video) and, when the upload exposes no audio-only stream, falls back to a
// combined audio/video format whose audio track HTMLAudioElement can consume
// (e.g. the legacy progressive mp4/webm). Manifest and fragmented protocols are
// rejected because the Range proxy streams a single progressive resource.
func ParseResolved(raw []byte, sourceID, quality string) (Resolved, error) {
	var info ytInfo
	if err := json.Unmarshal(raw, &info); err != nil {
		return Resolved{}, fmt.Errorf("%w: unreadable resolver output", ErrResolve)
	}

	diagf("resolve %s: raw yt-dlp JSON:\n%s", sourceID, truncateForDiag(raw))

	// Collect everything the media element could actually play, split into
	// audio-only and combined audio/video candidates.
	diagf("resolve %s: yt-dlp returned %d formats", sourceID, len(info.Formats))
	var audioOnly, combined []ytFormat
	for _, f := range info.Formats {
		if reason := rejectReason(f); reason != "" {
			diagf("  REJECT | format %s | ext %s | protocol %s | acodec %s | vcodec %s | abr %.0f | tbr %.0f | url=%t | %s",
				f.FormatID, f.Ext, f.Protocol, f.ACodec, f.VCodec, f.ABR, f.TBR, f.URL != "", reason)
			continue
		}
		diagf("  ACCEPT | format %s | ext %s | protocol %s | acodec %s | vcodec %s | abr %.0f | tbr %.0f | url=%t",
			f.FormatID, f.Ext, f.Protocol, f.ACodec, f.VCodec, f.ABR, f.TBR, f.URL != "")
		if f.VCodec == "none" || f.VCodec == "" {
			audioOnly = append(audioOnly, f)
		} else {
			combined = append(combined, f)
		}
	}

	// Prefer audio-only; fall back to a compatible audio/video stream only when
	// the video exposes no audio-only format at all.
	candidates := audioOnly
	if len(candidates) == 0 {
		candidates = combined
	}
	if len(candidates) == 0 {
		diagf("resolve %s: no playable stream (audio-only=%d combined=%d)", sourceID, len(audioOnly), len(combined))
		return Resolved{}, fmt.Errorf("%w: %s exposes %d formats but none is a single progressive audio stream",
			ErrNoAudio, sourceID, len(info.Formats))
	}

	rate := func(f ytFormat) float64 {
		if f.ABR > 0 {
			return f.ABR
		}
		return f.TBR
	}
	sort.SliceStable(candidates, func(i, j int) bool { return rate(candidates[i]) > rate(candidates[j]) })

	pick := candidates[0]
	switch quality {
	case "low":
		pick = candidates[len(candidates)-1]
	case "medium":
		pick = candidates[len(candidates)/2]
	}
	// Prefer m4a/mp4 (AAC) at the same tier: WebView2 seeks these most reliably.
	for _, f := range candidates {
		if rate(f) == rate(pick) && (f.Ext == "m4a" || f.Ext == "mp4") {
			pick = f
			break
		}
	}

	size := pick.Filesize
	if size == 0 {
		size = pick.FilesizeAp
	}
	res := Resolved{
		SourceID:  sourceID,
		URL:       pick.URL,
		MimeType:  mimeFor(pick),
		Duration:  info.Duration,
		Bitrate:   int(rate(pick)),
		Filesize:  size,
		ExpiresAt: expiryOf(pick.URL),
		Headers:   pick.HTTPHeaders,
		Title:     firstNonEmpty(info.Track, info.Title),
		Artist:    firstNonEmpty(info.Artist, info.Uploader, info.Channel),
		Album:     info.Album,
		Artwork:   info.Thumbnail,
	}
	if info.IsLive {
		return res, fmt.Errorf("%w: live streams aren't supported", ErrUnavailable)
	}
	return res, nil
}

// playableAudio reports whether a format carries audio the webview's
// HTMLAudioElement can consume through the plain-HTTP Range proxy, returning the
// mime type to advertise when the CDN supplies none of its own.
func playableAudio(f ytFormat) (string, bool) {
	if rejectReason(f) != "" {
		return "", false
	}
	mime, _ := audioMime(f.Ext)
	return mime, true
}

// rejectReason explains why a format is not playable through the Range proxy,
// or "" when it is. It doubles as the per-format diagnostic used when
// MELO_RESOLVER_DIAG is set.
func rejectReason(f ytFormat) string {
	switch {
	case f.URL == "":
		return "no url (PO-token/SABR-gated or manifest-only)"
	case f.ACodec == "" || f.ACodec == "none":
		return "no audio codec"
	case !streamable(f.Protocol):
		return fmt.Sprintf("protocol %q is not a single progressive stream", f.Protocol)
	}
	if _, ok := audioMime(f.Ext); !ok {
		return fmt.Sprintf("ext %q has no playable audio mapping", f.Ext)
	}
	return ""
}

// audioMime maps a yt-dlp container extension to the mime type HTMLAudioElement
// expects. It is keyed on ext only (never on codec): the real codec inside a
// container is decided by the browser's demuxer, not by the resolver.
func audioMime(ext string) (string, bool) {
	switch ext {
	case "m4a", "mp4":
		return "audio/mp4", true
	case "mp3":
		return "audio/mpeg", true
	case "webm":
		return "audio/webm", true
	case "opus", "ogg", "oga":
		return "audio/ogg", true
	}
	return "", false
}

// streamable reports whether the proxy can serve this format as one progressive
// resource over plain HTTP(S). Manifest and fragmented protocols (m3u8, dash,
// segmented DASH) are playlists or fragments, not a single media stream, so the
// media element can't consume them directly.
func streamable(protocol string) bool {
	switch protocol {
	case "", "http", "https":
		return true
	}
	return false
}

func mimeFor(f ytFormat) string {
	if mime, ok := audioMime(f.Ext); ok {
		return mime
	}
	return "audio/mpeg"
}

// expiryOf reads the `expire` query parameter Google puts on stream URLs.
func expiryOf(rawURL string) time.Time {
	idx := strings.Index(rawURL, "expire=")
	if idx < 0 {
		return time.Now().Add(2 * time.Hour)
	}
	rest := rawURL[idx+len("expire="):]
	if i := strings.IndexAny(rest, "&/"); i >= 0 {
		rest = rest[:i]
	}
	secs, err := strconv.ParseInt(rest, 10, 64)
	if err != nil || secs <= 0 {
		return time.Now().Add(2 * time.Hour)
	}
	return time.Unix(secs, 0)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
