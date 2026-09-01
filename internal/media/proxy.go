package media

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Proxy is a loopback HTTP server that streams resolved audio to the webview.
//
// Why a proxy at all: provider CDN URLs are bound to specific request headers
// and are not CORS-enabled, so the renderer cannot fetch them directly.
// Proxying also lets us re-resolve transparently when a URL expires mid-track.
type Proxy struct {
	resolver *Resolver
	token    string
	listener net.Listener
	server   *http.Server
	client   *http.Client

	mu      sync.RWMutex
	quality string
}

func NewProxy(r *Resolver) (*Proxy, error) {
	tokenBytes := make([]byte, 16)
	if _, err := rand.Read(tokenBytes); err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("playback engine unavailable: %w", err)
	}
	p := &Proxy{
		resolver: r,
		token:    hex.EncodeToString(tokenBytes),
		listener: ln,
		quality:  "high",
		client: &http.Client{
			Timeout: 0, // streaming responses; per-request contexts bound them
			Transport: &http.Transport{
				Proxy:               http.ProxyFromEnvironment,
				MaxIdleConnsPerHost: 4,
				IdleConnTimeout:     60 * time.Second,
			},
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/stream/", p.handleStream)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
	})
	p.server = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := p.server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("melo: stream proxy stopped: %v", err)
		}
	}()
	return p, nil
}

func (p *Proxy) SetQuality(q string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if q == "" {
		q = "high"
	}
	p.quality = q
}

func (p *Proxy) Quality() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.quality
}

func (p *Proxy) Addr() string { return p.listener.Addr().String() }

// URLFor returns the loopback URL the media element should load.
func (p *Proxy) URLFor(sourceID string) string {
	return fmt.Sprintf("http://%s/stream/%s/%s", p.Addr(), p.token, sourceID)
}

func (p *Proxy) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return p.server.Shutdown(ctx)
}

func (p *Proxy) handleStream(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/stream/"), "/")
	if len(parts) != 2 || parts[0] != p.token || parts[1] == "" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	sourceID := parts[1]

	res, err := p.resolver.Resolve(r.Context(), sourceID, p.Quality())
	if err != nil {
		writeErr(w, err)
		return
	}
	status, err := p.pipe(w, r, res)
	if err == nil {
		return
	}
	// A stale CDN URL answers 403/410: re-resolve once, then give up.
	if status == http.StatusForbidden || status == http.StatusGone {
		p.resolver.Invalidate(sourceID)
		res, rerr := p.resolver.Resolve(r.Context(), sourceID, p.Quality())
		if rerr != nil {
			writeErr(w, rerr)
			return
		}
		if _, perr := p.pipe(w, r, res); perr != nil {
			writeErr(w, perr)
		}
		return
	}
	writeErr(w, err)
}

// pipe forwards one request upstream, preserving Range semantics. It returns
// the upstream status when the failure came from upstream.
func (p *Proxy) pipe(w http.ResponseWriter, r *http.Request, res Resolved) (int, error) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, res.URL, nil)
	if err != nil {
		return 0, err
	}
	for k, v := range res.Headers {
		if strings.EqualFold(k, "Accept-Encoding") || strings.EqualFold(k, "Range") {
			continue
		}
		req.Header.Set(k, v)
	}
	if rng := r.Header.Get("Range"); rng != "" {
		req.Header.Set("Range", rng)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return 0, nil // the media element aborted; not an error
		}
		return 0, fmt.Errorf("couldn't reach the audio stream: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return resp.StatusCode, fmt.Errorf("audio stream returned HTTP %d", resp.StatusCode)
	}
	for _, h := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	if w.Header().Get("Content-Type") == "" && res.MimeType != "" {
		w.Header().Set("Content-Type", res.MimeType)
	}
	if w.Header().Get("Accept-Ranges") == "" {
		w.Header().Set("Accept-Ranges", "bytes")
	}
	w.Header().Set("Cache-Control", "no-store")
	// The webview origin is wails://; allow it to read the loopback stream.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(resp.StatusCode)
	if r.Method == http.MethodHead {
		return resp.StatusCode, nil
	}
	if _, err := io.Copy(w, resp.Body); err != nil {
		// Client-side aborts (seek, track change) are normal.
		return resp.StatusCode, nil
	}
	return resp.StatusCode, nil
}

func writeErr(w http.ResponseWriter, err error) {
	code := http.StatusBadGateway
	switch {
	case errors.Is(err, ErrUnavailable), errors.Is(err, ErrNoAudio):
		code = http.StatusNotFound
	case errors.Is(err, ErrResolve):
		code = http.StatusBadGateway
	}
	http.Error(w, err.Error(), code)
}
