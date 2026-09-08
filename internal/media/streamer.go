package media

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Streamer is the reusable HTTP streaming boundary shared by the desktop
// loopback proxy and the hosted API. It only accepts an already-validated
// provider source id; it can never be used as an arbitrary URL proxy.
type Streamer struct {
	resolver *Resolver
	client   *http.Client
}

func NewStreamer(resolver *Resolver) *Streamer {
	return &Streamer{
		resolver: resolver,
		client: &http.Client{
			Timeout: 0, // streaming responses are bounded by the request context
			Transport: &http.Transport{
				Proxy:               http.ProxyFromEnvironment,
				MaxIdleConns:        100,
				MaxIdleConnsPerHost: 12,
				IdleConnTimeout:     60 * time.Second,
			},
		},
	}
}

// Serve resolves and streams one source with byte-range support. Expired CDN
// URLs (403/410) are invalidated and resolved once more. Callers are responsible
// for authentication/ticket validation and CORS before invoking this method.
func (s *Streamer) Serve(w http.ResponseWriter, r *http.Request, sourceID, quality string) {
	res, err := s.resolver.Resolve(r.Context(), sourceID, quality)
	if err != nil {
		writeStreamError(w, err)
		return
	}
	status, err := s.pipe(w, r, res)
	if err == nil {
		return
	}
	if status == http.StatusForbidden || status == http.StatusGone {
		s.resolver.Invalidate(sourceID)
		res, resolveErr := s.resolver.Resolve(r.Context(), sourceID, quality)
		if resolveErr != nil {
			writeStreamError(w, resolveErr)
			return
		}
		if _, pipeErr := s.pipe(w, r, res); pipeErr != nil {
			writeStreamError(w, pipeErr)
		}
		return
	}
	writeStreamError(w, err)
}

func (s *Streamer) pipe(w http.ResponseWriter, r *http.Request, res Resolved) (int, error) {
	method := http.MethodGet
	if r.Method == http.MethodHead {
		method = http.MethodHead
	}
	req, err := http.NewRequestWithContext(r.Context(), method, res.URL, nil)
	if err != nil {
		return 0, err
	}
	for k, v := range res.Headers {
		if strings.EqualFold(k, "Accept-Encoding") || strings.EqualFold(k, "Range") || strings.EqualFold(k, "Host") {
			continue
		}
		req.Header.Set(k, v)
	}
	if rng := r.Header.Get("Range"); rng != "" {
		req.Header.Set("Range", rng)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return 0, nil // seeking and track changes normally abort old requests
		}
		return 0, fmt.Errorf("couldn't reach the audio stream: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return resp.StatusCode, fmt.Errorf("audio stream returned HTTP %d", resp.StatusCode)
	}
	for _, header := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"} {
		if value := resp.Header.Get(header); value != "" {
			w.Header().Set(header, value)
		}
	}
	if w.Header().Get("Content-Type") == "" && res.MimeType != "" {
		w.Header().Set("Content-Type", res.MimeType)
	}
	if w.Header().Get("Accept-Ranges") == "" {
		w.Header().Set("Accept-Ranges", "bytes")
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(resp.StatusCode)
	if method == http.MethodHead {
		return resp.StatusCode, nil
	}
	if _, err := io.Copy(w, resp.Body); err != nil {
		// A browser closing the stream is normal and should not trigger a retry.
		return resp.StatusCode, nil
	}
	return resp.StatusCode, nil
}

func writeStreamError(w http.ResponseWriter, err error) {
	code := http.StatusBadGateway
	switch {
	case errors.Is(err, ErrUnavailable), errors.Is(err, ErrNoAudio):
		code = http.StatusNotFound
	case errors.Is(err, context.DeadlineExceeded):
		code = http.StatusGatewayTimeout
	}
	http.Error(w, err.Error(), code)
}
