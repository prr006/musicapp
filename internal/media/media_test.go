package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeRunner struct {
	mu    sync.Mutex
	calls int32
	out   []byte
	err   error
	delay time.Duration
}

func (f *fakeRunner) Run(ctx context.Context, args ...string) ([]byte, error) {
	atomic.AddInt32(&f.calls, 1)
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return f.out, f.err
}

func infoJSON(t *testing.T, expire int64, formats []map[string]any) []byte {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"id": "vid", "title": "Song", "artist": "Band", "album": "LP",
		"duration": 210.0, "thumbnail": "http://img/x.jpg", "formats": formats,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = expire
	return raw
}

func audioFmt(id, ext string, abr float64, expire int64) map[string]any {
	return map[string]any{
		"format_id": id, "ext": ext, "acodec": "opus", "vcodec": "none", "abr": abr,
		"protocol": "https", "filesize": 1000,
		"url":          fmt.Sprintf("https://cdn.example/%s?expire=%d", id, expire),
		"http_headers": map[string]string{"User-Agent": "test-agent"},
	}
}

func TestParseResolvedPicksBestAudioOnly(t *testing.T) {
	exp := time.Now().Add(time.Hour).Unix()
	raw := infoJSON(t, exp, []map[string]any{
		{"format_id": "video", "ext": "mp4", "acodec": "aac", "vcodec": "h264", "abr": 320.0, "url": "https://cdn/v", "protocol": "https"},
		audioFmt("low", "webm", 64, exp),
		audioFmt("mid", "webm", 128, exp),
		audioFmt("high", "webm", 160, exp),
		{"format_id": "hls", "ext": "m4a", "acodec": "aac", "vcodec": "none", "abr": 256.0, "url": "https://cdn/h", "protocol": "m3u8_native"},
	})
	res, err := ParseResolved(raw, "vid", "high")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.URL, "/high") {
		t.Fatalf("expected the highest audio-only bitrate, got %s", res.URL)
	}
	if res.Duration != 210 || res.Artist != "Band" || res.Album != "LP" {
		t.Fatalf("metadata lost: %+v", res)
	}
	if res.ExpiresAt.Unix() != exp {
		t.Fatalf("expiry not parsed: %v", res.ExpiresAt)
	}
	if res.Headers["User-Agent"] != "test-agent" {
		t.Fatalf("upstream headers dropped: %+v", res.Headers)
	}

	low, err := ParseResolved(raw, "vid", "low")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(low.URL, "/low") {
		t.Fatalf("expected lowest tier, got %s", low.URL)
	}
}

func TestParseResolvedPrefersM4AAtSameBitrate(t *testing.T) {
	exp := time.Now().Add(time.Hour).Unix()
	raw := infoJSON(t, exp, []map[string]any{
		audioFmt("webm160", "webm", 160, exp),
		audioFmt("m4a160", "m4a", 160, exp),
	})
	res, err := ParseResolved(raw, "vid", "high")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.URL, "m4a160") || res.MimeType != "audio/mp4" {
		t.Fatalf("expected m4a preference, got %s (%s)", res.URL, res.MimeType)
	}
}

func TestParseResolvedNoAudio(t *testing.T) {
	raw := infoJSON(t, 0, []map[string]any{
		// Video-only stream: no audio track at all, so nothing is playable.
		{"format_id": "v", "ext": "mp4", "acodec": "none", "vcodec": "h264", "url": "https://cdn/v", "protocol": "https"},
		// Storyboard/image stream: neither audio nor video.
		{"format_id": "sb", "ext": "mhtml", "acodec": "none", "vcodec": "none", "url": "https://cdn/sb", "protocol": "https"},
	})
	if _, err := ParseResolved(raw, "vid", "high"); !errors.Is(err, ErrNoAudio) {
		t.Fatalf("expected ErrNoAudio, got %v", err)
	}
	if _, err := ParseResolved([]byte("garbage"), "vid", "high"); !errors.Is(err, ErrResolve) {
		t.Fatalf("expected ErrResolve, got %v", err)
	}
}

// TestParseResolvedFallsBackToCombinedAV covers uploads that expose no
// audio-only stream (e.g. legacy progressive-only videos). The webview's
// HTMLAudioElement plays the audio track of a combined mp4/webm, so the
// resolver must still return a playable stream instead of giving up.
func TestParseResolvedFallsBackToCombinedAV(t *testing.T) {
	exp := time.Now().Add(time.Hour).Unix()
	raw := infoJSON(t, exp, []map[string]any{
		{"format_id": "18", "ext": "mp4", "acodec": "mp4a.40.2", "vcodec": "avc1.42001E", "abr": 96, "tbr": 500,
			"width": 640, "height": 360, "url": fmt.Sprintf("https://cdn/18?expire=%d", exp), "protocol": "https", "filesize": 5000000},
		{"format_id": "43", "ext": "webm", "acodec": "vorbis", "vcodec": "vp8.0", "abr": 128, "tbr": 700,
			"width": 640, "height": 360, "url": fmt.Sprintf("https://cdn/43?expire=%d", exp), "protocol": "https"},
	})
	res, err := ParseResolved(raw, "vid", "high")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.URL, "/43") {
		t.Fatalf("expected highest-bitrate combined A/V fallback, got %s", res.URL)
	}
	if res.MimeType != "audio/webm" {
		t.Fatalf("expected an audio mime type for the combined fallback, got %s", res.MimeType)
	}
}

// TestParseResolvedPrefersAudioOnlyOverCombined verifies the resolver never
// pulls a video stream when a real audio-only stream exists (even if the video
// stream has a higher tbr).
func TestParseResolvedPrefersAudioOnlyOverCombined(t *testing.T) {
	exp := time.Now().Add(time.Hour).Unix()
	raw := infoJSON(t, exp, []map[string]any{
		audioFmt("140", "m4a", 128, exp),
		{"format_id": "18", "ext": "mp4", "acodec": "mp4a.40.2", "vcodec": "avc1.42001E", "abr": 96, "tbr": 600,
			"height": 360, "url": fmt.Sprintf("https://cdn/18?expire=%d", exp), "protocol": "https"},
	})
	res, err := ParseResolved(raw, "vid", "high")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.URL, "/140") {
		t.Fatalf("expected the audio-only stream, got %s", res.URL)
	}
}

// TestParseResolvedRejectsUnplayableFormats ensures manifest streams (HLS/DASH)
// and video-only streams are never returned: the media element can only consume
// a single progressive HTTP resource.
func TestParseResolvedRejectsUnplayableFormats(t *testing.T) {
	raw := infoJSON(t, 0, []map[string]any{
		{"format_id": "hls", "ext": "mp4", "acodec": "mp4a.40.2", "vcodec": "avc1.42001E", "url": "https://cdn/h.m3u8", "protocol": "m3u8_native"},
		{"format_id": "dash", "ext": "m4a", "acodec": "mp4a.40.2", "vcodec": "none", "url": "https://cdn/d.mpd", "protocol": "http_dash_segments"},
		{"format_id": "vo", "ext": "mp4", "acodec": "none", "vcodec": "avc1.64001f", "url": "https://cdn/vo", "protocol": "https"},
	})
	if _, err := ParseResolved(raw, "vid", "high"); !errors.Is(err, ErrNoAudio) {
		t.Fatalf("expected ErrNoAudio for manifest/video-only formats, got %v", err)
	}
}

// TestParseResolvedEmptyFormats covers the case where yt-dlp itself drops every
// candidate (PO-token/SABR-gated or DRM-skipped) and, thanks to
// --ignore-no-formats-error, still dumps a JSON whose format list is empty.
func TestParseResolvedEmptyFormats(t *testing.T) {
	raw := []byte(`{"id": "vid", "title": "Song", "formats": []}`)
	if _, err := ParseResolved(raw, "vid", "high"); !errors.Is(err, ErrNoAudio) {
		t.Fatalf("expected ErrNoAudio for an empty format list, got %v", err)
	}
}

// ---------------- representative yt-dlp JSON fixtures ----------------

// TestParseResolvedTopicAudioUpload exercises a topic-style / audio upload: the
// video exposes audio-only formats and no video stream at all. This is exactly
// the shape that used to make yt-dlp's default "best/bestvideo+bestaudio"
// selection fail and, before the resolver passed --ignore-no-formats-error,
// abort with "Requested format is not available".
func TestParseResolvedTopicAudioUpload(t *testing.T) {
	raw := []byte(`{
	  "id": "abc123topic",
	  "title": "Song - Topic",
	  "track": "Song",
	  "artist": "Artist",
	  "album": "Album",
	  "uploader": "Artist - Topic",
	  "channel": "Artist - Topic",
	  "duration": 210.0,
	  "thumbnail": "https://i.ytimg.com/vi/abc123topic/hqdefault.jpg",
	  "formats": [
	    {"format_id":"249","url":"https://cdn/249?expire=1","ext":"webm","acodec":"opus","vcodec":"none","abr":50,"tbr":50,"protocol":"https","filesize":1200000,"mime_type":"audio/webm; codecs=\"opus\"","http_headers":{"User-Agent":"ua"},"audio_ext":"webm"},
	    {"format_id":"250","url":"https://cdn/250?expire=1","ext":"webm","acodec":"opus","vcodec":"none","abr":70,"tbr":70,"protocol":"https","filesize":1600000,"mime_type":"audio/webm; codecs=\"opus\""},
	    {"format_id":"140","url":"https://cdn/140?expire=1","ext":"m4a","acodec":"mp4a.40.2","vcodec":"none","abr":128,"tbr":128,"protocol":"https","filesize":2800000,"mime_type":"audio/mp4; codecs=\"mp4a.40.2\"","audio_ext":"m4a"},
	    {"format_id":"251","url":"https://cdn/251?expire=1","ext":"webm","acodec":"opus","vcodec":"none","abr":160,"tbr":160,"protocol":"https","filesize":3600000,"mime_type":"audio/webm; codecs=\"opus\""}
	  ]
	}`)
	res, err := ParseResolved(raw, "abc123topic", "high")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.URL, "/251") {
		t.Fatalf("expected highest audio-only stream, got %s", res.URL)
	}
	if res.Title != "Song" || res.Artist != "Artist" || res.Album != "Album" {
		t.Fatalf("metadata lost: %+v", res)
	}
	if res.Artwork != "https://i.ytimg.com/vi/abc123topic/hqdefault.jpg" {
		t.Fatalf("artwork lost: %+v", res.Artwork)
	}
}

// TestParseResolvedOfficialMusicVideo exercises a modern official music video:
// separate video-only and audio-only streams with no pre-merged format. Only
// audio is needed, so a video-only stream must never be returned.
func TestParseResolvedOfficialMusicVideo(t *testing.T) {
	raw := []byte(`{
	  "id": "xyzmusic",
	  "title": "Hit - Official Music Video",
	  "uploader": "ArtistVEVO",
	  "channel": "ArtistVEVO",
	  "duration": 245.0,
	  "thumbnail": "https://i.ytimg.com/vi/xyzmusic/maxresdefault.jpg",
	  "formats": [
	    {"format_id":"137","url":"https://cdn/137?expire=1","ext":"mp4","acodec":"none","vcodec":"avc1.640028","height":1080,"tbr":3000,"protocol":"https"},
	    {"format_id":"136","url":"https://cdn/136?expire=1","ext":"mp4","acodec":"none","vcodec":"avc1.4d401f","height":720,"tbr":2000,"protocol":"https"},
	    {"format_id":"140","url":"https://cdn/140?expire=1","ext":"m4a","acodec":"mp4a.40.2","vcodec":"none","abr":128,"tbr":128,"protocol":"https"},
	    {"format_id":"251","url":"https://cdn/251?expire=1","ext":"webm","acodec":"opus","vcodec":"none","abr":160,"tbr":160,"protocol":"https"}
	  ]
	}`)
	res, err := ParseResolved(raw, "xyzmusic", "high")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.URL, "/251") {
		t.Fatalf("expected highest audio-only stream, got %s", res.URL)
	}
	if res.Artist != "ArtistVEVO" {
		t.Fatalf("uploader/channel fallback for artist lost: %+v", res)
	}
}

// TestParseResolvedLegacyProgressiveOnly exercises an older upload whose only
// surviving formats are combined A/V progressive streams (itag 18/43).
func TestParseResolvedLegacyProgressiveOnly(t *testing.T) {
	raw := []byte(`{
	  "id": "oldclip",
	  "title": "Old upload",
	  "uploader": "Channel",
	  "duration": 120.0,
	  "thumbnail": "https://i.ytimg.com/vi/oldclip/hqdefault.jpg",
	  "formats": [
	    {"format_id":"18","url":"https://cdn/18?expire=1","ext":"mp4","acodec":"mp4a.40.2","vcodec":"avc1.42001E","abr":96,"tbr":500,"height":360,"protocol":"https"},
	    {"format_id":"43","url":"https://cdn/43?expire=1","ext":"webm","acodec":"vorbis","vcodec":"vp8.0","abr":128,"tbr":700,"height":360,"protocol":"https"}
	  ]
	}`)
	res, err := ParseResolved(raw, "oldclip", "high")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.URL, "/43") {
		t.Fatalf("expected combined A/V fallback (highest audio bitrate), got %s", res.URL)
	}
	if res.MimeType != "audio/webm" {
		t.Fatalf("expected audio/webm mime for combined webm fallback, got %s", res.MimeType)
	}
}

func TestResolverCachesAndDedupes(t *testing.T) {
	exp := time.Now().Add(time.Hour).Unix()
	r := &fakeRunner{out: infoJSON(t, exp, []map[string]any{audioFmt("a", "m4a", 128, exp)}), delay: 40 * time.Millisecond}
	res := NewResolver(r)

	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := res.Resolve(context.Background(), "vid", "high"); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if got := atomic.LoadInt32(&r.calls); got != 1 {
		t.Fatalf("expected a single resolver invocation, got %d", got)
	}
	if _, err := res.Resolve(context.Background(), "vid", "high"); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&r.calls); got != 1 {
		t.Fatalf("cache miss: %d calls", got)
	}
	res.Invalidate("vid")
	if _, err := res.Resolve(context.Background(), "vid", "high"); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&r.calls); got != 2 {
		t.Fatalf("invalidate did not force a refetch: %d", got)
	}
}

func TestResolverExpiredEntryRefetches(t *testing.T) {
	past := time.Now().Add(-time.Hour).Unix()
	r := &fakeRunner{out: infoJSON(t, past, []map[string]any{audioFmt("a", "m4a", 128, past)})}
	res := NewResolver(r)
	if _, err := res.Resolve(context.Background(), "vid", "high"); err != nil {
		t.Fatal(err)
	}
	if _, err := res.Resolve(context.Background(), "vid", "high"); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&r.calls); got != 2 {
		t.Fatalf("expired entry should be refetched, got %d calls", got)
	}
}

func TestResolverSurfacesRealErrors(t *testing.T) {
	res := NewResolver(&fakeRunner{err: errors.New("ERROR: Video unavailable")})
	_, err := res.Resolve(context.Background(), "vid", "high")
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("expected ErrUnavailable, got %v", err)
	}
	res2 := NewResolver(&fakeRunner{err: errors.New("unable to resolve host name")})
	_, err = res2.Resolve(context.Background(), "vid", "high")
	if err == nil || !strings.Contains(err.Error(), "couldn't reach YouTube") {
		t.Fatalf("expected a network message, got %v", err)
	}
	// The extractor raises "No video formats found" when every candidate was
	// dropped (PO-token/SABR-gated, DRM-skipped, or nothing downloadable).
	res3 := NewResolver(&fakeRunner{err: errors.New("ERROR: [youtube] vid: No video formats found")})
	if _, err = res3.Resolve(context.Background(), "vid", "high"); !errors.Is(err, ErrNoAudio) {
		t.Fatalf("expected ErrNoAudio for a no-formats extractor error, got %v", err)
	}
	if _, err := res.Resolve(context.Background(), "", "high"); err == nil {
		t.Fatal("expected an error for an empty source id")
	}
}

// ---------------- proxy ----------------

func newTestProxy(t *testing.T, upstream string) (*Proxy, *fakeRunner) {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"id": "vid", "duration": 10.0, "formats": []map[string]any{{
			"format_id": "a", "ext": "m4a", "acodec": "aac", "vcodec": "none", "abr": 128.0,
			"protocol": "https", "url": upstream,
			"http_headers": map[string]string{"User-Agent": "test-agent"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{out: raw}
	p, err := NewProxy(NewResolver(runner))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Close() })
	return p, runner
}

const payload = "0123456789abcdefghijklmnopqrstuvwxyz"

func upstreamServer(t *testing.T, fail *int32) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail != nil && atomic.LoadInt32(fail) > 0 {
			atomic.AddInt32(fail, -1)
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if r.Header.Get("User-Agent") != "test-agent" {
			t.Errorf("upstream headers not forwarded: %q", r.Header.Get("User-Agent"))
		}
		http.ServeContent(w, r, "audio.m4a", time.Unix(0, 0), strings.NewReader(payload))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestProxyStreamsAndSupportsRanges(t *testing.T) {
	up := upstreamServer(t, nil)
	p, _ := newTestProxy(t, up.URL)

	resp, err := http.Get(p.URLFor("vid"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(body) != payload {
		t.Fatalf("bad full response: %d %q", resp.StatusCode, body)
	}
	if resp.Header.Get("Accept-Ranges") != "bytes" {
		t.Fatal("expected range support to be advertised (seeking depends on it)")
	}

	req, _ := http.NewRequest("GET", p.URLFor("vid"), nil)
	req.Header.Set("Range", "bytes=10-19")
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	body2, _ := io.ReadAll(resp2.Body)
	if resp2.StatusCode != http.StatusPartialContent || string(body2) != payload[10:20] {
		t.Fatalf("range request failed: %d %q", resp2.StatusCode, body2)
	}
	if resp2.Header.Get("Content-Range") == "" {
		t.Fatal("Content-Range not forwarded")
	}
}

func TestProxyRejectsBadToken(t *testing.T) {
	up := upstreamServer(t, nil)
	p, _ := newTestProxy(t, up.URL)
	resp, err := http.Get(fmt.Sprintf("http://%s/stream/wrong-token/vid", p.Addr()))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for an unknown token, got %d", resp.StatusCode)
	}
}

func TestProxyReResolvesOnExpiredURL(t *testing.T) {
	var fail int32 = 1
	up := upstreamServer(t, &fail)
	p, runner := newTestProxy(t, up.URL)

	resp, err := http.Get(p.URLFor("vid"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(body) != payload {
		t.Fatalf("expected transparent recovery, got %d %q", resp.StatusCode, body)
	}
	if atomic.LoadInt32(&runner.calls) != 2 {
		t.Fatalf("expected exactly one re-resolve, got %d resolver calls", runner.calls)
	}
}

func TestProxyReportsResolveFailure(t *testing.T) {
	runner := &fakeRunner{err: errors.New("ERROR: Video unavailable")}
	p, err := NewProxy(NewResolver(runner))
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	resp, err := http.Get(p.URLFor("vid"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for unavailable media, got %d", resp.StatusCode)
	}
	msg, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(msg), "media unavailable") {
		t.Fatalf("expected an actionable message, got %q", msg)
	}
}
