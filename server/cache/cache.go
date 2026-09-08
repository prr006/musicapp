// Package cache provides small in-memory TTL caches, concurrent request
// coalescing, and provider failure backoff. The interfaces are intentionally
// replaceable by Redis-backed implementations for multi-instance deployments.
package cache

import (
	"context"
	"errors"
	"sync"
	"time"
)

type entry[T any] struct {
	value     T
	expiresAt time.Time
}

type call[T any] struct {
	done  chan struct{}
	value T
	err   error
}

type Group[T any] struct {
	mu       sync.Mutex
	entries  map[string]entry[T]
	inFlight map[string]*call[T]
	now      func() time.Time
}

func NewGroup[T any]() *Group[T] {
	return &Group[T]{entries: make(map[string]entry[T]), inFlight: make(map[string]*call[T]), now: time.Now}
}

// Get loads a key once. Concurrent callers share the same provider request;
// successful values are cached for ttl while failures are never cached.
func (g *Group[T]) Get(ctx context.Context, key string, ttl time.Duration, load func(context.Context) (T, error)) (T, error) {
	g.mu.Lock()
	now := g.now()
	if len(g.entries) > 2_048 {
		for cachedKey, cached := range g.entries {
			if !now.Before(cached.expiresAt) {
				delete(g.entries, cachedKey)
			}
		}
	}
	if cached, ok := g.entries[key]; ok && now.Before(cached.expiresAt) {
		g.mu.Unlock()
		return cached.value, nil
	}
	if running, ok := g.inFlight[key]; ok {
		g.mu.Unlock()
		select {
		case <-running.done:
			return running.value, running.err
		case <-ctx.Done():
			var zero T
			return zero, ctx.Err()
		}
	}
	running := &call[T]{done: make(chan struct{})}
	g.inFlight[key] = running
	g.mu.Unlock()

	running.value, running.err = load(ctx)

	g.mu.Lock()
	delete(g.inFlight, key)
	if running.err == nil {
		g.entries[key] = entry[T]{value: running.value, expiresAt: g.now().Add(ttl)}
	}
	close(running.done)
	g.mu.Unlock()
	return running.value, running.err
}

func (g *Group[T]) Delete(key string) {
	g.mu.Lock()
	delete(g.entries, key)
	g.mu.Unlock()
}

var ErrCircuitOpen = errors.New("provider is temporarily unavailable; retry shortly")

type Breaker struct {
	mu        sync.Mutex
	failures  int
	threshold int
	openUntil time.Time
	backoff   time.Duration
	now       func() time.Time
}

func NewBreaker(threshold int, backoff time.Duration) *Breaker {
	return &Breaker{threshold: threshold, backoff: backoff, now: time.Now}
}

func (b *Breaker) Do(ctx context.Context, fn func(context.Context) error) error {
	b.mu.Lock()
	if b.now().Before(b.openUntil) {
		b.mu.Unlock()
		return ErrCircuitOpen
	}
	b.mu.Unlock()

	err := fn(ctx)
	b.mu.Lock()
	defer b.mu.Unlock()
	if err == nil {
		b.failures = 0
		b.openUntil = time.Time{}
		return nil
	}
	b.failures++
	if b.failures >= b.threshold {
		b.openUntil = b.now().Add(b.backoff)
	}
	return err
}
