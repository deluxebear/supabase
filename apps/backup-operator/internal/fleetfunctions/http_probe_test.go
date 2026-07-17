package fleetfunctions

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestHTTPProberRetriesUntilRuntimeConverges(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/functions/v1/hello" {
			t.Fatalf("probe path=%q", request.URL.Path)
		}
		if attempts.Add(1) < 3 {
			response.Header().Set("X-Supabase-Fleet-Revision", strings.Repeat("a", 64))
		} else {
			response.Header().Set("X-Supabase-Fleet-Revision", strings.Repeat("b", 64))
		}
		response.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	prober := HTTPProber{BaseURL: server.URL + "/functions/v1", Timeout: time.Second, Interval: time.Millisecond}
	if err := prober.ProbeRevision(context.Background(), "hello", true, strings.Repeat("b", 64)); err != nil {
		t.Fatal(err)
	}
	if attempts.Load() != 3 {
		t.Fatalf("probe attempts=%d; want 3", attempts.Load())
	}
}

func TestHTTPProberReportsLastStatusAfterTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	prober := HTTPProber{BaseURL: server.URL, Timeout: 30 * time.Millisecond, Interval: 5 * time.Millisecond}
	err := prober.Probe(context.Background(), "broken", true)
	if err == nil || !strings.Contains(err.Error(), "HTTP 500") {
		t.Fatalf("probe error=%v", err)
	}
}
