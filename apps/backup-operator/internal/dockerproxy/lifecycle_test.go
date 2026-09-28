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

type lifecycleEngine struct {
	mu        sync.Mutex
	forwarded []string
	queries   map[string]string
}

func labels(project, service string) map[string]string {
	return map[string]string{composeProjectLabel: project, composeServiceLabel: service}
}

func (e *lifecycleEngine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	e.mu.Lock()
	e.forwarded = append(e.forwarded, r.Method+" "+r.URL.Path)
	e.queries[r.Method+" "+r.URL.Path] = r.URL.RawQuery
	e.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	containers := map[string]map[string]string{
		"auth1":  labels("managed-a", "auth"),
		"db1":    labels("managed-a", "db"),
		"other1": labels("managed-b", "auth"),
	}
	networks := map[string]map[string]any{
		"managed-a_default": {"Name": "managed-a_default", "Labels": map[string]string{composeProjectLabel: "managed-a"}},
		"fleet-management":  {"Name": "fleet-management", "Labels": map[string]string{}},
		"bridge":            {"Name": "bridge", "Labels": map[string]string{}},
	}
	volumes := map[string]map[string]string{
		"managed-a_managed-db-data": {composeProjectLabel: "managed-a"},
		"managed-b_managed-db-data": {composeProjectLabel: "managed-b"},
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	switch {
	case r.Method == http.MethodGet && len(parts) == 3 && parts[0] == "containers" && parts[2] == "json":
		if value, ok := containers[parts[1]]; ok {
			_ = json.NewEncoder(w).Encode(map[string]any{"Config": map[string]any{"Labels": value}})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	case r.Method == http.MethodGet && len(parts) == 2 && parts[0] == "networks":
		if value, ok := networks[parts[1]]; ok {
			_ = json.NewEncoder(w).Encode(value)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	case r.Method == http.MethodGet && len(parts) == 2 && parts[0] == "volumes":
		if value, ok := volumes[parts[1]]; ok {
			_ = json.NewEncoder(w).Encode(map[string]any{"Labels": value})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	default:
		_, _ = w.Write([]byte(`{}`))
	}
}

func (e *lifecycleEngine) wasForwarded(request string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, value := range e.forwarded {
		if value == request {
			return true
		}
	}
	return false
}

func newLifecycleProxy(t *testing.T) (*httptest.Server, *lifecycleEngine) {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "docker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	engine := &lifecycleEngine{queries: map[string]string{}}
	upstream := &http.Server{Handler: engine}
	go func() { _ = upstream.Serve(listener) }()
	t.Cleanup(func() { _ = upstream.Close() })
	proxy, err := New(Config{
		SocketPath: socket, ComposeProject: "managed-a", Rules: LifecycleRules(),
		Services: []string{"auth", "rest", "functions"}, ExternalNetworks: []string{"fleet-management"},
		BindPrefixes: []string{"/srv/fleet/functions"},
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(proxy)
	t.Cleanup(server.Close)
	return server, engine
}

func send(t *testing.T, method, url, body string) int {
	t.Helper()
	request, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	return response.StatusCode
}

func createBody(t *testing.T, mutate func(map[string]any)) string {
	t.Helper()
	body := map[string]any{
		"Image":  "supabase/gotrue:v2.189.0",
		"Labels": labels("managed-a", "auth"),
		"HostConfig": map[string]any{
			"NetworkMode": "managed-a_default",
			"Mounts": []map[string]string{
				{"Type": "volume", "Source": "managed-a_deno-cache"},
				{"Type": "bind", "Source": "/srv/fleet/functions/abc"},
			},
		},
	}
	if mutate != nil {
		mutate(body)
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestLifecycleAllowsServiceWrites(t *testing.T) {
	server, engine := newLifecycleProxy(t)
	for _, request := range []struct{ method, path string }{
		{http.MethodPost, "/v1.45/containers/auth1/restart"},
		{http.MethodPost, "/containers/auth1/stop"},
		{http.MethodPost, "/containers/auth1/start"},
		{http.MethodPost, "/containers/auth1/rename?name=managed-a-auth"},
		{http.MethodDelete, "/containers/auth1?force=1&v=1"},
		{http.MethodGet, "/networks/fleet-management"},
		{http.MethodGet, "/volumes/managed-a_managed-db-data"},
		{http.MethodHead, "/_ping"},
		{http.MethodGet, "/images/supabase/gotrue:v2.189.0/json"},
		{http.MethodGet, "/images/json?filters=%7B%22reference%22%3A%5B%22supabase%2Fgotrue%22%5D%7D"},
	} {
		if status := send(t, request.method, server.URL+request.path, ""); status != http.StatusOK {
			t.Fatalf("%s %s = %d, want 200", request.method, request.path, status)
		}
	}
	engine.mu.Lock()
	deleteQuery := engine.queries["DELETE /containers/auth1"]
	engine.mu.Unlock()
	if !strings.Contains(deleteQuery, "v=0") || strings.Contains(deleteQuery, "v=1") {
		t.Fatalf("container removal must keep volumes, query %q", deleteQuery)
	}
}

func TestLifecycleRejectsOutOfScopeWrites(t *testing.T) {
	server, engine := newLifecycleProxy(t)
	cases := []struct{ method, path string }{
		{http.MethodPost, "/containers/db1/restart"},
		{http.MethodPost, "/containers/other1/restart"},
		{http.MethodDelete, "/containers/db1"},
		{http.MethodPost, "/containers/auth1/exec"},
		{http.MethodPost, "/containers/auth1/kill"},
		{http.MethodPost, "/images/create"},
		{http.MethodPost, "/networks/create"},
		{http.MethodPost, "/volumes/create"},
		{http.MethodGet, "/networks/bridge"},
		{http.MethodGet, "/volumes/managed-b_managed-db-data"},
	}
	for _, tc := range cases {
		if status := send(t, tc.method, server.URL+tc.path, ""); status != http.StatusForbidden {
			t.Fatalf("%s %s = %d, want 403", tc.method, tc.path, status)
		}
	}
	for _, write := range []string{"POST /containers/db1/restart", "POST /containers/other1/restart", "DELETE /containers/db1"} {
		if engine.wasForwarded(write) {
			t.Fatalf("denied write %q reached the engine", write)
		}
	}
}

func TestLifecycleValidatesContainerCreate(t *testing.T) {
	server, engine := newLifecycleProxy(t)
	withManagementNetwork := createBody(t, func(body map[string]any) {
		body["NetworkingConfig"] = map[string]any{"EndpointsConfig": map[string]any{"managed-a_default": map[string]any{}, "fleet-management": map[string]any{}}}
	})
	if status := send(t, http.MethodPost, server.URL+"/containers/create?name=tmp_managed-a-auth", withManagementNetwork); status != http.StatusOK {
		t.Fatalf("valid create = %d, want 200", status)
	}
	if !engine.wasForwarded("POST /containers/create") {
		t.Fatal("valid create did not reach the engine")
	}
	host := func(mutate func(map[string]any)) func(map[string]any) {
		return func(body map[string]any) { mutate(body["HostConfig"].(map[string]any)) }
	}
	rejected := map[string]func(map[string]any){
		"other project": func(body map[string]any) { body["Labels"] = labels("managed-b", "auth") },
		"db service":    func(body map[string]any) { body["Labels"] = labels("managed-a", "db") },
		"privileged":    host(func(h map[string]any) { h["Privileged"] = true }),
		"cap add":       host(func(h map[string]any) { h["CapAdd"] = []string{"SYS_ADMIN"} }),
		"host network":  host(func(h map[string]any) { h["NetworkMode"] = "host" }),
		"host pid":      host(func(h map[string]any) { h["PidMode"] = "host" }),
		"shared ns":     host(func(h map[string]any) { h["IpcMode"] = "container:db1" }),
		"devices":       host(func(h map[string]any) { h["Devices"] = []map[string]string{{"PathOnHost": "/dev/sda"}} }),
		"unconfined":    host(func(h map[string]any) { h["SecurityOpt"] = []string{"seccomp=unconfined"} }),
		"socket bind":   host(func(h map[string]any) { h["Binds"] = []string{"/var/run/docker.sock:/var/run/docker.sock"} }),
		"root bind": host(func(h map[string]any) {
			h["Mounts"] = []map[string]string{{"Type": "bind", "Source": "/"}}
		}),
		"escaping bind": host(func(h map[string]any) {
			h["Mounts"] = []map[string]string{{"Type": "bind", "Source": "/srv/fleet/functions/../../etc"}}
		}),
		"sibling prefix": host(func(h map[string]any) {
			h["Mounts"] = []map[string]string{{"Type": "bind", "Source": "/srv/fleet/functions-evil"}}
		}),
		"foreign volume": host(func(h map[string]any) { h["Binds"] = []string{"managed-b_managed-db-data:/data"} }),
		"bridge network": host(func(h map[string]any) { h["NetworkMode"] = "bridge" }),
		"foreign endpoint": func(body map[string]any) {
			body["NetworkingConfig"] = map[string]any{"EndpointsConfig": map[string]any{"managed-b_default": map[string]any{}}}
		},
		"npipe mount": host(func(h map[string]any) {
			h["Mounts"] = []map[string]string{{"Type": "npipe", "Source": "x"}}
		}),
	}
	for name, mutate := range rejected {
		if status := send(t, http.MethodPost, server.URL+"/containers/create", createBody(t, mutate)); status != http.StatusForbidden {
			t.Fatalf("%s create = %d, want 403", name, status)
		}
	}
	if status := send(t, http.MethodPost, server.URL+"/containers/create", "not json"); status != http.StatusForbidden {
		t.Fatalf("invalid JSON create = %d, want 403", status)
	}
}

func TestLifecycleNetworkAttachRequiresServiceContainer(t *testing.T) {
	server, _ := newLifecycleProxy(t)
	if status := send(t, http.MethodPost, server.URL+"/networks/fleet-management/connect", `{"Container":"auth1"}`); status != http.StatusOK {
		t.Fatalf("service attach = %d, want 200", status)
	}
	for name, request := range map[string]struct{ network, body string }{
		"db container":   {"managed-a_default", `{"Container":"db1"}`},
		"other project":  {"managed-a_default", `{"Container":"other1"}`},
		"bridge network": {"bridge", `{"Container":"auth1"}`},
		"missing body":   {"managed-a_default", `{}`},
	} {
		if status := send(t, http.MethodPost, server.URL+"/networks/"+request.network+"/connect", request.body); status == http.StatusOK {
			t.Fatalf("%s attach was allowed", name)
		}
	}
}

func TestLifecycleForcesProjectFilterOnEventsAndNetworks(t *testing.T) {
	server, engine := newLifecycleProxy(t)
	setFilter := `/events?filters=` + `%7B%22label%22%3A%7B%22com.docker.compose.project%3Dmanaged-a%22%3Atrue%7D%7D`
	for _, path := range []string{setFilter, "/networks"} {
		if status := send(t, http.MethodGet, server.URL+path, ""); status != http.StatusOK {
			t.Fatalf("GET %s = %d, want 200", path, status)
		}
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	for _, key := range []string{"GET /events", "GET /networks"} {
		if !strings.Contains(engine.queries[key], "managed-a") {
			t.Fatalf("%s query %q lacks the project filter", key, engine.queries[key])
		}
	}
}

func TestNewRejectsWriteRulesWithoutServices(t *testing.T) {
	if _, err := New(Config{SocketPath: "/s", ComposeProject: "a", Rules: LifecycleRules()}); err == nil {
		t.Fatal("expected write rules without services to be rejected")
	}
	if _, err := New(Config{SocketPath: "/s", ComposeProject: "a", Rules: LifecycleRules(), Services: []string{"auth"}, BindPrefixes: []string{"/"}}); err == nil {
		t.Fatal("expected a root bind prefix to be rejected")
	}
}
