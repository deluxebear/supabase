package fleetagent

import (
	"testing"
	"time"
)

func TestReconnectDelayBoundsAndDistributesStorm(t *testing.T) {
	const agents = 300
	buckets := map[time.Duration]int{}
	for i := 0; i < agents; i++ {
		delay := reconnectDelay(30*time.Second, nil)
		if delay < 15*time.Second || delay > 30*time.Second {
			t.Fatalf("reconnect delay %s is outside bounded jitter window", delay)
		}
		buckets[delay/time.Second]++
	}
	if len(buckets) < 8 {
		t.Fatalf("reconnect storm was insufficiently distributed across time buckets: %v", buckets)
	}
}

func TestReconnectDelayRejectsUnsafeInjectedJitter(t *testing.T) {
	delay := reconnectDelay(10*time.Second, func(time.Duration) time.Duration { return 0 })
	if delay < 5*time.Second || delay > 10*time.Second {
		t.Fatalf("unsafe jitter escaped bounds: %s", delay)
	}
}
