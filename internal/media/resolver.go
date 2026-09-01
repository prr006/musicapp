// Package media turns a Track into something the webview's media element can
// actually play. It has two halves:
//
//	Resolver — asks yt-dlp for the best audio-only stream for a source id and
//	           caches the answer until the CDN URL expires.
//	Proxy    — a loopback HTTP server that streams that URL to the media
//	           element with byte-range support, so seeking works and the
//	           provider's headers/CORS never reach the renderer.
//
// The resolver is deliberately independent from playback: it knows about
// YouTube, the player does not.
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
	ErrResolve     = errors.New("couldn't load this song")
	ErrNoAudio     = errors.New("this song has no playable audio stream")
	ErrUnavailable = errors.New("media unavailable")
)

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
	mu     sync.Mutex
	cache  map[string]Resolved
	inWork map[string]*call
	now    func() time.Time
}

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
		return hit, nil
	}
	if c, ok := r.inWork[key]; ok {
		r.mu.Unlock()
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

	c.res, c.err = r.fetch(ctx, sourceID, quality)
	close(c.done)

	r.mu.Lock()
	delete(r.inWork, key)
	if c.err == nil {
		r.cache[key] = c.res
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

func (r *Resolver) fetch(ctx context.Context, sourceID, quality string) (Resolved, error) {
	out, err := r.runner.Run(ctx,
		"--dump-single-json", "--no-playlist", "--no-warnings",
		"--extractor-args", "youtube:player_client=web_music,web",
		"https://www.youtube.com/watch?v="+sourceID,
	)
	if err != nil {
		msg := strings.ToLower(err.Error())
		switch {
		case strings.Contains(msg, "private") || strings.Contains(msg, "unavailable") ||
			strings.Contains(msg, "removed") || strings.Contains(msg, "age"):
			return Resolved{}, fmt.Errorf("%w: %s", ErrUnavailable, firstLine(err.Error()))
		case strings.Contains(msg, "resolve host") || strings.Contains(msg, "network") ||
			strings.Contains(msg, "timed out") || strings.Contains(msg, "urlopen"):
			return Resolved{}, fmt.Errorf("couldn't reach YouTube: %s", firstLine(err.Error()))
		}
		return Resolved{}, fmt.Errorf("%w: %s", ErrResolve, firstLine(err.Error()))
	}
	return ParseResolved(out, sourceID, quality)
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
	MimeType    string            `json:"mime_type"`
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

// ParseResolved picks the best audio-only progressive stream for the requested
// quality tier from yt-dlp JSON.
func ParseResolved(raw []byte, sourceID, quality string) (Resolved, error) {
	var info ytInfo
	if err := json.Unmarshal(raw, &info); err != nil {
		return Resolved{}, fmt.Errorf("%w: unreadable resolver output", ErrResolve)
	}
	var audio []ytFormat
	for _, f := range info.Formats {
		if f.URL == "" || f.ACodec == "none" || f.ACodec == "" {
			continue
		}
		if f.VCodec != "none" && f.VCodec != "" {
			continue
		}
		if strings.HasPrefix(f.Protocol, "m3u8") || strings.Contains(f.Protocol, "dash") {
			continue // the media element handles plain HTTP ranges, not manifests
		}
		audio = append(audio, f)
	}
	if len(audio) == 0 {
		return Resolved{}, ErrNoAudio
	}
	rate := func(f ytFormat) float64 {
		if f.ABR > 0 {
			return f.ABR
		}
		return f.TBR
	}
	sort.SliceStable(audio, func(i, j int) bool { return rate(audio[i]) > rate(audio[j]) })

	pick := audio[0]
	switch quality {
	case "low":
		pick = audio[len(audio)-1]
	case "medium":
		pick = audio[len(audio)/2]
	}
	// Prefer m4a/mp4 at the same tier: WebView2 seeks these most reliably.
	for _, f := range audio {
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

func mimeFor(f ytFormat) string {
	if f.MimeType != "" {
		return f.MimeType
	}
	switch f.Ext {
	case "m4a", "mp4":
		return "audio/mp4"
	case "webm":
		return "audio/webm"
	case "opus":
		return "audio/ogg"
	case "mp3":
		return "audio/mpeg"
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
