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

// Proxy is the capability-protected loopback server used by the Wails desktop
// build. Hosted web streaming uses the same Streamer behind API-issued,
// short-lived tickets instead of exposing this listener.
type Proxy struct {
	resolver *Resolver
	streamer *Streamer
	token    string
	listener net.Listener
	server   *http.Server

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
		streamer: NewStreamer(r),
		token:    hex.EncodeToString(tokenBytes),
		listener: ln,
		quality:  "high",
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
	// Wails loads the media from its custom origin. The loopback capability URL
	// is unguessable, and this wildcard applies only to the desktop listener.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	p.streamer.Serve(w, r, parts[1], p.Quality())
}
