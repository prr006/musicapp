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
var ErrUpstreamStream = errors.New("provider audio stream unavailable")

type StreamFailure struct {
	Stage     string
	SourceID  string
	RequestID string
	Status    int
	Failure   string
}

type Streamer struct {
	resolver *Resolver
	client   *http.Client
	onError  func(StreamFailure)
}

// SetFailureObserver installs a diagnostics callback. Events contain only the
// provider source id, stage, request id, status, and classified failure; raw
// errors, provider URLs, request headers, cookies, and signing capabilities are
// never included.
func (s *Streamer) SetFailureObserver(observer func(StreamFailure)) {
	s.onError = observer
}

func (s *Streamer) report(r *http.Request, stage, sourceID string, status int, err error) {
	if s.onError == nil || err == nil {
		return
	}
	s.onError(StreamFailure{
		Stage: stage, SourceID: sourceID, RequestID: r.Header.Get("X-Melo-Request-ID"),
		Status: status, Failure: FailureClass(err),
	})
}

// FailureClass is deliberately lossy: it provides operationally useful labels
// without allowing wrapped HTTP client or resolver errors to leak signed URLs.
func FailureClass(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, ErrUnavailable):
		return "media_unavailable"
	case errors.Is(err, ErrNoAudio):
		return "no_audio"
	case errors.Is(err, ErrResolve):
		return "resolve_failed"
	case errors.Is(err, ErrUpstreamStream):
		return "upstream_unavailable"
	default:
		return "stream_failed"
	}
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
		s.report(r, "stream_resolve", sourceID, 0, err)
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
			s.report(r, "stream_reresolve", sourceID, status, resolveErr)
			writeStreamError(w, resolveErr)
			return
		}
		if retryStatus, pipeErr := s.pipe(w, r, res); pipeErr != nil {
			s.report(r, "stream_retry", sourceID, retryStatus, pipeErr)
			writeStreamError(w, pipeErr)
		}
		return
	}
	s.report(r, "upstream_stream", sourceID, status, err)
	writeStreamError(w, err)
}

func (s *Streamer) pipe(w http.ResponseWriter, r *http.Request, res Resolved) (int, error) {
	method := http.MethodGet
	if r.Method == http.MethodHead {
		method = http.MethodHead
	}
	req, err := http.NewRequestWithContext(r.Context(), method, res.URL, nil)
	if err != nil {
		return 0, ErrUpstreamStream
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
		if errors.Is(err, context.DeadlineExceeded) {
			return 0, context.DeadlineExceeded
		}
		return 0, ErrUpstreamStream
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
	message := "Playback stream is temporarily unavailable."
	switch {
	case errors.Is(err, ErrUnavailable), errors.Is(err, ErrNoAudio):
		code = http.StatusNotFound
		message = "media unavailable: this track has no playable source."
	case errors.Is(err, context.DeadlineExceeded):
		code = http.StatusGatewayTimeout
		message = "Playback stream timed out."
	}
	http.Error(w, message, code)
}
