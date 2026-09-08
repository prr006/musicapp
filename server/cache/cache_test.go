package cache

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestGroupDeduplicatesConcurrentLoads(t *testing.T) {
	group := NewGroup[string]()
	var calls int32
	start := make(chan struct{})
	load := func(context.Context) (string, error) {
		atomic.AddInt32(&calls, 1)
		<-start
		return "value", nil
	}
	var wait sync.WaitGroup
	for i := 0; i < 8; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			value, err := group.Get(context.Background(), "same", time.Minute, load)
			if err != nil || value != "value" {
				t.Errorf("unexpected result %q, %v", value, err)
			}
		}()
	}
	time.Sleep(10 * time.Millisecond)
	close(start)
	wait.Wait()
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("expected one provider call, got %d", got)
	}
}
