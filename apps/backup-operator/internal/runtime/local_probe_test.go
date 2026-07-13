package runtime

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLocalFenceProbeUsesAllowlistAndTypedHealth(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer server.Close()
	var command string
	probe := LocalSinglePrimaryProbe{HealthURLs: []string{server.URL}, Run: func(_ context.Context, path string, args ...string) error { command = path; return nil }}
	if err := probe.ProbeFence(context.Background(), SinglePrimaryConfig{FenceAdapter: "systemd"}); err != nil {
		t.Fatal(err)
	}
	if command != "/bin/systemctl" {
		t.Fatalf("unexpected command %s", command)
	}
	if err := probe.ProbeFence(context.Background(), SinglePrimaryConfig{FenceAdapter: "shell"}); err == nil {
		t.Fatal("unallowlisted fence adapter accepted")
	}
}
