package dockerproxy

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type fakeEngine struct {
	mu       sync.Mutex
	requests []string
	queries  []string
}

func (f *fakeEngine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.requests = append(f.requests, r.Method+" "+r.URL.Path)
	f.queries = append(f.queries, r.URL.RawQuery)
	f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.URL.Path == "/containers/mine/json":
		_ = json.NewEncoder(w).Encode(map[string]any{"Config": map[string]any{"Labels": map[string]string{composeProjectLabel: "managed-a"}}})
	case r.URL.Path == "/containers/other/json":
		_ = json.NewEncoder(w).Encode(map[string]any{"Config": map[string]any{"Labels": map[string]string{composeProjectLabel: "managed-b"}}})
	case strings.HasPrefix(r.URL.Path, "/containers/") && strings.HasSuffix(r.URL.Path, "/json") && r.URL.Path != "/containers/json":
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"no such container"}`))
	default:
		_, _ = w.Write([]byte(`[]`))
	}
}

func (f *fakeEngine) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.requests...)
}

func newTestProxy(t *testing.T) (*httptest.Server, *fakeEngine) {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "docker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	engine := &fakeEngine{}
	upstream := &http.Server{Handler: engine}
	go func() { _ = upstream.Serve(listener) }()
	t.Cleanup(func() { _ = upstream.Close() })
	proxy, err := New(Config{SocketPath: socket, ComposeProject: "managed-a", Rules: ReadOnlyInventoryRules()})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(proxy)
	t.Cleanup(server.Close)
	return server, engine
}

func do(t *testing.T, method, url string) *http.Response {
	t.Helper()
	request, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = response.Body.Close() })
	return response
}

func TestAllowsInventoryReads(t *testing.T) {
	server, engine := newTestProxy(t)
	for _, path := range []string{"/_ping", "/info", "/v1.45/info", "/system/df?type=volume", "/containers/mine/json"} {
		if response := do(t, http.MethodGet, server.URL+path); response.StatusCode != http.StatusOK {
			t.Fatalf("GET %s = %d, want 200", path, response.StatusCode)
		}
	}
	if got := engine.seen(); len(got) == 0 {
		t.Fatal("expected requests to reach the engine")
	}
}

func TestRejectsWritesAndUnlistedPaths(t *testing.T) {
	server, engine := newTestProxy(t)
	cases := []struct{ method, path string }{
		{http.MethodPost, "/containers/mine/restart"},
		{http.MethodPost, "/containers/create"},
		{http.MethodDelete, "/containers/mine"},
		{http.MethodPost, "/containers/mine/exec"},
		{http.MethodGet, "/containers/mine/logs"},
		{http.MethodGet, "/images/json"},
		{http.MethodGet, "/secrets"},
		{http.MethodPut, "/containers/mine/archive"},
	}
	for _, tc := range cases {
		if response := do(t, tc.method, server.URL+tc.path); response.StatusCode != http.StatusForbidden {
			t.Fatalf("%s %s = %d, want 403", tc.method, tc.path, response.StatusCode)
		}
	}
	if got := engine.seen(); len(got) != 0 {
		t.Fatalf("denied requests reached the engine: %v", got)
	}
}

func TestRejectsContainersOutsideProject(t *testing.T) {
	server, engine := newTestProxy(t)
	if response := do(t, http.MethodGet, server.URL+"/containers/other/json"); response.StatusCode != http.StatusForbidden {
		t.Fatalf("other-project inspect = %d, want 403", response.StatusCode)
	}
	if response := do(t, http.MethodGet, server.URL+"/containers/missing/json"); response.StatusCode != http.StatusForbidden {
		t.Fatalf("missing container inspect = %d, want 403", response.StatusCode)
	}
	for _, request := range engine.seen() {
		if request != "GET /containers/other/json" && request != "GET /containers/missing/json" {
			t.Fatalf("unexpected forwarded request %q", request)
		}
	}
}

func TestForcesProjectFilterOnContainerList(t *testing.T) {
	server, engine := newTestProxy(t)
	if response := do(t, http.MethodGet, server.URL+"/containers/json?all=1"); response.StatusCode != http.StatusOK {
		t.Fatalf("list = %d, want 200", response.StatusCode)
	}
	engine.mu.Lock()
	query := engine.queries[len(engine.queries)-1]
	engine.mu.Unlock()
	if !strings.Contains(query, "managed-a") {
		t.Fatalf("forwarded list query %q lacks the project filter", query)
	}
	other := `/containers/json?filters=` + `%7B%22label%22%3A%5B%22com.docker.compose.project%3Dmanaged-b%22%5D%7D`
	if response := do(t, http.MethodGet, server.URL+other); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("list with other project filter = %d, want 400", response.StatusCode)
	}
}

func TestForceProjectFilterKeepsOtherLabels(t *testing.T) {
	query, err := forceProjectFilter(map[string][]string{"filters": {`{"label":["tier=db"],"status":["running"]}`}}, "managed-a")
	if err != nil {
		t.Fatal(err)
	}
	var filters map[string][]string
	if err := json.Unmarshal([]byte(query.Get("filters")), &filters); err != nil {
		t.Fatal(err)
	}
	if len(filters["label"]) != 2 || filters["label"][1] != composeProjectLabel+"=managed-a" || filters["status"][0] != "running" {
		t.Fatalf("unexpected filters %v", filters)
	}
}

func TestNewRequiresConfiguration(t *testing.T) {
	if _, err := New(Config{ComposeProject: "a", Rules: ReadOnlyInventoryRules()}); err == nil {
		t.Fatal("expected missing socket error")
	}
	if _, err := New(Config{SocketPath: "/s", Rules: ReadOnlyInventoryRules()}); err == nil {
		t.Fatal("expected missing project error")
	}
	if _, err := New(Config{SocketPath: "/s", ComposeProject: "a"}); err == nil {
		t.Fatal("expected missing rules error")
	}
}
