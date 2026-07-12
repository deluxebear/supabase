package hardening

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestValidateCapacityRequiresFreshObservationAndMargin(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	observation := CapacityObservation{RequiredBytes: 100, AvailableBytes: 120, ObservedAt: now}
	if err := ValidateCapacity(observation, now, time.Minute, 20); err != nil {
		t.Fatal(err)
	}
	observation.AvailableBytes = 119
	if err := ValidateCapacity(observation, now, time.Minute, 20); err == nil {
		t.Fatal("expected margin rejection")
	}
	observation.AvailableBytes = 200
	if err := ValidateCapacity(observation, now.Add(2*time.Minute), time.Minute, 20); err == nil {
		t.Fatal("expected stale observation rejection")
	}
}

func TestObjectLimiterRetriesWithinBound(t *testing.T) {
	limiter, _ := NewObjectLimiter(1, 2, time.Millisecond)
	var attempts atomic.Int32
	err := limiter.Do(context.Background(), func(context.Context) error {
		if attempts.Add(1) < 3 {
			return errors.New("throttled")
		}
		return nil
	})
	if err != nil || attempts.Load() != 3 {
		t.Fatalf("retry result: %d %v", attempts.Load(), err)
	}
}

func TestBatchObserverBoundsTopologyConcurrency(t *testing.T) {
	var active, peak atomic.Int32
	observer := BatchObserver[int]{Limit: 2, Observe: func(context.Context, int) error {
		current := active.Add(1)
		for {
			old := peak.Load()
			if current <= old || peak.CompareAndSwap(old, current) {
				break
			}
		}
		time.Sleep(time.Millisecond)
		active.Add(-1)
		return nil
	}}
	if err := observer.Run(context.Background(), []int{1, 2, 3, 4, 5}); err != nil {
		t.Fatal(err)
	}
	if peak.Load() > 2 {
		t.Fatalf("concurrency exceeded: %d", peak.Load())
	}
}
