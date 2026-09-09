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
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ErrResolve         = errors.New("couldn't load this song")
	ErrNoAudio         = errors.New("this song has no playable audio stream")
	ErrUnavailable     = errors.New("media unavailable")
	ErrProviderNetwork = errors.New("provider network unavailable")
)

// ResolverAttempt is a sanitized account of one bounded yt-dlp player-client
// attempt. It deliberately contains no provider URL, header, token, cookie, or
// raw provider response and is safe to attach to operational error responses.
type ResolverAttempt struct {
	Attempt                   int      `json:"attempt"`
	Clients                   string   `json:"clients"`
	Outcome                   string   `json:"outcome"`
	DurationMS                int64    `json:"durationMs"`
	Final                     bool     `json:"final"`
	FormatCount               int      `json:"formatCount"`
	FormatsWithURL            int      `json:"formatsWithUrl"`
	AudioFormatsWithURL       int      `json:"audioFormatsWithUrl"`
	SupportedProgressiveAudio int      `json:"supportedProgressiveAudio"`
	Protocols                 []string `json:"protocols"`
}

// ResolverDiagnostics is a sanitized summary of a bounded resolution. It is
// safe to return to clients: it deliberately excludes media URLs, headers,
// signatures, cookies, tokens, command stderr, and raw provider responses.
type ResolverDiagnostics struct {
	Attempts            []ResolverAttempt `json:"attempts"`
	FinalOutcome        string            `json:"finalOutcome"`
	DurationMS          int64             `json:"durationMs"`
	RecoveredAfterRetry bool              `json:"recoveredAfterRetry"`
	Cached              bool              `json:"cached"`
	Coalesced           bool              `json:"coalesced"`
}

// ResolverMetadata is the non-sensitive media identity returned by yt-dlp
// before MELO filters its formats. Descriptions, URLs, headers, and tokens are
// intentionally excluded.
type ResolverMetadata struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	Track        string  `json:"track"`
	Artist       string  `json:"artist"`
	Uploader     string  `json:"uploader"`
	Album        string  `json:"album"`
	Duration     float64 `json:"duration"`
	Availability string  `json:"availability"`
	LiveStatus   string  `json:"liveStatus"`
}

type resolverAttemptError struct {
	cause       error
	diagnostics ResolverDiagnostics
	metadata    *ResolverMetadata
}

func (e *resolverAttemptError) Error() string { return e.cause.Error() }
func (e *resolverAttemptError) Unwrap() error { return e.cause }

func cloneResolverDiagnostics(d ResolverDiagnostics) ResolverDiagnostics {
	d.Attempts = append([]ResolverAttempt(nil), d.Attempts...)
	for i := range d.Attempts {
		if d.Attempts[i].Protocols != nil {
			d.Attempts[i].Protocols = append([]string{}, d.Attempts[i].Protocols...)
		}
	}
	return d
}

// ResolverAttempts extracts a defensive copy of the sanitized client outcomes
// from a failed resolution.
func ResolverAttempts(err error) []ResolverAttempt {
	diagnostics := ResolverFailureDiagnostics(err)
	if diagnostics == nil {
		return nil
	}
	return diagnostics.Attempts
}

// ResolverFailureDiagnostics returns the safe bounded-attempt summary attached
// to a failed resolution.
func ResolverFailureDiagnostics(err error) *ResolverDiagnostics {
	var attemptErr *resolverAttemptError
	if !errors.As(err, &attemptErr) {
		return nil
	}
	diagnostics := cloneResolverDiagnostics(attemptErr.diagnostics)
	return &diagnostics
}

// ResolverFailureMetadata returns a copy of the safe yt-dlp metadata associated
// with a failed resolution, when the provider returned parseable JSON.
func ResolverFailureMetadata(err error) *ResolverMetadata {
	var attemptErr *resolverAttemptError
	if !errors.As(err, &attemptErr) || attemptErr.metadata == nil {
		return nil
	}
	metadata := *attemptErr.metadata
	return &metadata
}

type Runner interface {
	Run(ctx context.Context, args ...string) ([]byte, error)
}

// Resolved is the raw upstream stream description (internal to Go).
type Resolved struct {
	SourceID    string
	URL         string
	MimeType    string
	Duration    float64
	Bitrate     int
	Filesize    int64
	ExpiresAt   time.Time
	Headers     map[string]string
	Title       string
	Artist      string
	Album       string
	Artwork     string
	Diagnostics ResolverDiagnostics
}

func (r Resolved) Expired(now time.Time) bool {
	return !r.ExpiresAt.IsZero() && now.After(r.ExpiresAt.Add(-30*time.Second))
}

type Resolver struct {
	runner        Runner
	mu            sync.Mutex
	cache         map[string]Resolved
	inWork        map[string]*call
	now           func() time.Time
	retryBackoffs []time.Duration
}

type call struct {
	done chan struct{}
	res  Resolved
	err  error
}

func NewResolver(r Runner) *Resolver {
	return &Resolver{
		runner:        r,
		cache:         map[string]Resolved{},
		inWork:        map[string]*call{},
		now:           time.Now,
		retryBackoffs: []time.Duration{150 * time.Millisecond, 350 * time.Millisecond},
	}
}

// Resolve returns a playable upstream URL for sourceID. Concurrent callers for
// the same key share one yt-dlp invocation; results are cached until expiry.
func (r *Resolver) Resolve(ctx context.Context, sourceID, quality string) (Resolved, error) {
	if strings.TrimSpace(sourceID) == "" {
		return Resolved{}, ErrResolve
	}
	key := sourceID + "|" + quality

	r.mu.Lock()
	if hit, ok := r.cache[key]; ok && !hit.Expired(r.now()) {
		r.mu.Unlock()
		hit.Diagnostics = ResolverDiagnostics{
			Attempts: []ResolverAttempt{}, FinalOutcome: "resolved", Cached: true,
		}
		return hit, nil
	}
	if c, ok := r.inWork[key]; ok {
		r.mu.Unlock()
		select {
		case <-c.done:
			resolved := c.res
			if c.err == nil {
				resolved.Diagnostics = cloneResolverDiagnostics(resolved.Diagnostics)
				resolved.Diagnostics.Coalesced = true
			}
			return resolved, c.err
		case <-ctx.Done():
			return Resolved{}, ctx.Err()
		}
	}
	c := &call{done: make(chan struct{})}
	r.inWork[key] = c
	r.mu.Unlock()

	c.res, c.err = r.fetch(ctx, sourceID, quality)
	close(c.done)

	r.mu.Lock()
	delete(r.inWork, key)
	if c.err == nil {
		cached := c.res
		cached.Diagnostics = ResolverDiagnostics{
			Attempts: []ResolverAttempt{}, FinalOutcome: "resolved", Cached: true,
		}
		r.cache[key] = cached
	}
	r.mu.Unlock()
	return c.res, c.err
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
//   - android, ios: HTTPS requires a PO token or a player token.
//   - android_vr: adaptive HTTPS formats may require a token, but the combined
//     progressive format 18 remains available for many videos.
//   - visionos, web_embedded, tv, tv_downgraded: no PO-token requirement.
//
// MELO is unauthenticated and ships no PO-token provider or account cookies.
// Start with yt-dlp's JS-free default, then make two bounded supported-client
// fallbacks. android_vr is intentionally retained as a compatibility fallback:
// its lower-bitrate combined MP4 is directly playable by HTMLAudioElement and
// restores music videos for which visionos exposes no progressive audio. The
// final set covers embeddable and made-for-kids media. No missing-token format
// is enabled and no access restriction is bypassed.
var resolveClients = []string{
	"visionos,web",
	"android_vr",
	"web_embedded,tv_downgraded",
}

func (r *Resolver) fetch(ctx context.Context, sourceID, quality string) (Resolved, error) {
	// A retry round preserves the exact ordered client policy. Only a successful
	// yt-dlp response whose decoded format list is empty can start another round;
	// process, transport, explicit-unavailable, and non-empty unsupported-format
	// outcomes keep their existing behavior.
	started := time.Now()
	var lastErr error
	var metadata *ResolverMetadata
	attempts := make([]ResolverAttempt, 0, len(resolveClients)*(len(r.retryBackoffs)+1))

	finishDiagnostics := func(finalOutcome string, recovered bool) ResolverDiagnostics {
		if len(attempts) > 0 {
			attempts[len(attempts)-1].Final = true
		}
		return ResolverDiagnostics{
			Attempts:            append([]ResolverAttempt(nil), attempts...),
			FinalOutcome:        finalOutcome,
			DurationMS:          time.Since(started).Milliseconds(),
			RecoveredAfterRetry: recovered,
		}
	}
	failed := func(err error) (Resolved, error) {
		return Resolved{}, &resolverAttemptError{
			cause:       err,
			diagnostics: finishDiagnostics(resolverFinalOutcome(err), false),
			metadata:    metadata,
		}
	}

	for round := 0; ; round++ {
		sawZeroFormats := false
		sawNonZeroFormats := false
		for _, clients := range resolveClients {
			args := []string{
				"--dump-single-json", "--no-playlist", "--no-warnings",
				"--ignore-no-formats-error",
				"--extractor-args", "youtube:player_client=" + clients,
				"https://www.youtube.com/watch?v=" + sourceID,
			}
			attemptStarted := time.Now()
			out, err := r.runner.Run(ctx, args...)
			attempt := ResolverAttempt{
				Attempt: len(attempts) + 1, Clients: clients,
				DurationMS: time.Since(attemptStarted).Milliseconds(), Protocols: []string{},
			}
			if err != nil {
				if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
					attempt.Outcome = "provider_timeout"
					attempts = append(attempts, attempt)
					return failed(err)
				}
				switch classifyResolverError(err) {
				case ErrNoAudio:
					attempt.Outcome = "no_supported_audio"
					attempts = append(attempts, attempt)
					sawNonZeroFormats = true
					lastErr = fmt.Errorf("%w: %s", ErrNoAudio, firstLine(err.Error()))
					continue
				case ErrProviderNetwork:
					attempt.Outcome = "provider_network"
					attempts = append(attempts, attempt)
					return failed(fmt.Errorf("%w: resolver request failed", ErrProviderNetwork))
				case ErrUnavailable:
					attempt.Outcome = "provider_unavailable"
					attempts = append(attempts, attempt)
					// UNPLAYABLE can be client-specific. Try the remaining bounded
					// supported clients; private/removed media fails every set.
					lastErr = fmt.Errorf("%w: provider rejected this media for %s", ErrUnavailable, clients)
					continue
				default:
					attempt.Outcome = "resolver_process_error"
					attempts = append(attempts, attempt)
					return failed(fmt.Errorf("%w: resolver process failed", ErrResolve))
				}
			}

			inspected, attemptMetadata := inspectResolverOutput(out, clients)
			inspected.Attempt = attempt.Attempt
			inspected.DurationMS = attempt.DurationMS
			attempt = inspected
			if metadata == nil && attemptMetadata != nil {
				metadata = attemptMetadata
			}
			res, perr := ParseResolved(out, sourceID, quality)
			if perr == nil {
				attempt.Outcome = "resolved"
				attempts = append(attempts, attempt)
				res.Diagnostics = finishDiagnostics("resolved", round > 0)
				return res, nil
			}
			if errors.Is(perr, ErrNoAudio) {
				if attempt.FormatCount == 0 {
					attempt.Outcome = "zero_formats"
					sawZeroFormats = true
				} else {
					attempt.Outcome = "no_supported_audio"
					sawNonZeroFormats = true
				}
				attempts = append(attempts, attempt)
				lastErr = perr
				continue
			}
			if errors.Is(perr, ErrUnavailable) {
				attempt.Outcome = "provider_unavailable"
			} else {
				attempt.Outcome = "unreadable_response"
			}
			attempts = append(attempts, attempt)
			return failed(perr)
		}

		// Retry only the exact transient condition established in production: all
		// successfully decoded format responses in this round were empty. Each
		// next round invokes fresh yt-dlp subprocesses for the unchanged clients.
		if sawZeroFormats && !sawNonZeroFormats {
			if round < len(r.retryBackoffs) {
				if err := waitForResolverRetry(ctx, r.retryBackoffs[round]); err != nil {
					return failed(err)
				}
				continue
			}
			return failed(fmt.Errorf("%w: provider temporarily returned zero formats", ErrUnavailable))
		}
		if lastErr != nil {
			return failed(lastErr)
		}
		return failed(ErrNoAudio)
	}
}

func waitForResolverRetry(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
			return nil
		}
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func resolverFinalOutcome(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		return "provider_timeout"
	case errors.Is(err, ErrUnavailable):
		return "media_unavailable"
	case errors.Is(err, ErrNoAudio):
		return "no_supported_audio"
	case errors.Is(err, ErrProviderNetwork):
		return "provider_network"
	default:
		return "resolver_error"
	}
}

func classifyResolverError(err error) error {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return ErrProviderNetwork
	}
	message := strings.ToLower(err.Error())
	if containsAny(message,
		"requested format is not available",
		"no video formats",
		"no formats found",
	) {
		return ErrNoAudio
	}
	// Check transport failures before media status. In particular, the old
	// `strings.Contains(message, "age")` check matched the word "page" in
	// yt-dlp's common "Unable to download API page" network error and falsely
	// reported ordinary TLS failures as age-restricted media.
	if containsAny(message,
		"resolve host", "network", "timed out", "timeout", "urlopen",
		"tls", "ssl", "connection reset", "connection refused",
		"connection closed", "remote end closed", "unexpected eof",
		"temporary failure in name resolution",
	) {
		return ErrProviderNetwork
	}
	if containsAny(message,
		"video unavailable", "media unavailable", "private video",
		"this video is private", "removed by the uploader", "has been removed",
		"not available in your country", "age-restricted", "age restricted",
		"confirm your age",
	) {
		return ErrUnavailable
	}
	return ErrResolve
}

func containsAny(message string, fragments ...string) bool {
	for _, fragment := range fragments {
		if strings.Contains(message, fragment) {
			return true
		}
	}
	return false
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
	ID           string     `json:"id"`
	Title        string     `json:"title"`
	Artist       string     `json:"artist"`
	Track        string     `json:"track"`
	Album        string     `json:"album"`
	Uploader     string     `json:"uploader"`
	Channel      string     `json:"channel"`
	Duration     float64    `json:"duration"`
	Thumbnail    string     `json:"thumbnail"`
	Formats      []ytFormat `json:"formats"`
	Availability string     `json:"availability"`
	LiveStatus   string     `json:"live_status"`
	IsLive       bool       `json:"is_live"`
}

func inspectResolverOutput(raw []byte, clients string) (ResolverAttempt, *ResolverMetadata) {
	attempt := ResolverAttempt{Clients: clients}
	var info ytInfo
	if json.Unmarshal(raw, &info) != nil {
		return attempt, nil
	}
	protocols := map[string]struct{}{}
	attempt.Protocols = []string{}
	attempt.FormatCount = len(info.Formats)
	for _, format := range info.Formats {
		if format.Protocol != "" {
			protocols[format.Protocol] = struct{}{}
		}
		if format.URL != "" {
			attempt.FormatsWithURL++
		}
		if format.URL != "" && format.ACodec != "" && format.ACodec != "none" {
			attempt.AudioFormatsWithURL++
		}
		if rejectReason(format) == "" {
			attempt.SupportedProgressiveAudio++
		}
	}
	for protocol := range protocols {
		attempt.Protocols = append(attempt.Protocols, protocol)
	}
	sort.Strings(attempt.Protocols)
	metadata := &ResolverMetadata{
		ID: info.ID, Title: info.Title, Track: info.Track, Artist: info.Artist,
		Uploader: info.Uploader, Album: info.Album, Duration: info.Duration,
		Availability: info.Availability, LiveStatus: info.LiveStatus,
	}
	return attempt, metadata
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

	// Collect everything the media element could actually play, split into
	// audio-only and combined audio/video candidates.
	var audioOnly, combined []ytFormat
	for _, f := range info.Formats {
		if rejectReason(f) != "" {
			continue
		}
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
// or "" when it is.
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
