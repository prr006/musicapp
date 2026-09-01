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
		{"format_id": "v", "ext": "mp4", "acodec": "aac", "vcodec": "h264", "url": "https://cdn/v", "protocol": "https"},
	})
	if _, err := ParseResolved(raw, "vid", "high"); !errors.Is(err, ErrNoAudio) {
		t.Fatalf("expected ErrNoAudio, got %v", err)
	}
	if _, err := ParseResolved([]byte("garbage"), "vid", "high"); !errors.Is(err, ErrResolve) {
		t.Fatalf("expected ErrResolve, got %v", err)
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
