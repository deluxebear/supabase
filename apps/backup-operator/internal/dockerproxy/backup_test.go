package dockerproxy

import (
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func newBackupProxy(t *testing.T) (*httptest.Server, *lifecycleEngine) {
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
	proxy, err := New(Config{SocketPath: socket, ComposeProject: "managed-a", Rules: BackupRules(), Services: []string{"db", "db-validation"}})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(proxy)
	t.Cleanup(server.Close)
	return server, engine
}

func TestBackupAllowsDatabaseLifecycleOnly(t *testing.T) {
	server, engine := newBackupProxy(t)
	for _, request := range []struct{ method, path string }{
		{http.MethodGet, "/v1.45/containers/db1/json"},
		{http.MethodGet, "/containers/auth1/json"},
		{http.MethodPost, "/containers/db1/restart"},
		{http.MethodPost, "/containers/db1/stop?t=30"},
		{http.MethodPost, "/containers/db1/start"},
		{http.MethodHead, "/_ping"},
	} {
		if status := send(t, request.method, server.URL+request.path, ""); status != http.StatusOK {
			t.Fatalf("%s %s = %d, want 200", request.method, request.path, status)
		}
	}
	for _, request := range []struct{ method, path string }{
		{http.MethodPost, "/containers/auth1/restart"},
		{http.MethodPost, "/containers/other1/restart"},
		{http.MethodGet, "/containers/other1/json"},
		{http.MethodPost, "/containers/db1/exec"},
		{http.MethodPost, "/containers/db1/kill"},
		{http.MethodDelete, "/containers/db1"},
		{http.MethodPost, "/containers/create"},
		{http.MethodGet, "/containers/json"},
		{http.MethodGet, "/volumes/managed-a_managed-db-data"},
		{http.MethodPost, "/networks/fleet-management/connect"},
	} {
		if status := send(t, request.method, server.URL+request.path, ""); status != http.StatusForbidden {
			t.Fatalf("%s %s = %d, want 403", request.method, request.path, status)
		}
	}
	for _, write := range []string{"POST /containers/auth1/restart", "POST /containers/other1/restart", "DELETE /containers/db1"} {
		if engine.wasForwarded(write) {
			t.Fatalf("denied write %q reached the engine", write)
		}
	}
}
