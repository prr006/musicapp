package api

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type bucket struct {
	tokens float64
	last   time.Time
}

type rateLimiter struct {
	mu       sync.Mutex
	clients  map[string]*bucket
	rate     float64 // tokens per second
	capacity float64
	now      func() time.Time
}

func newRateLimiter(perMinute, burst int) *rateLimiter {
	return &rateLimiter{clients: make(map[string]*bucket), rate: float64(perMinute) / 60, capacity: float64(burst), now: time.Now}
}

func (l *rateLimiter) allow(key string) bool {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.clients) > 10_000 {
		for client, existing := range l.clients {
			if now.Sub(existing.last) > 10*time.Minute {
				delete(l.clients, client)
			}
		}
	}
	b := l.clients[key]
	if b == nil {
		b = &bucket{tokens: l.capacity, last: now}
		l.clients[key] = b
	}
	elapsed := now.Sub(b.last).Seconds()
	b.tokens = minFloat(l.capacity, b.tokens+elapsed*l.rate)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0]); forwarded != "" {
			return forwarded
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}

func minFloat(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
