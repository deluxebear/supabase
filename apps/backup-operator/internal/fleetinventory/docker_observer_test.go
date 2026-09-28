package fleetinventory

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/dockerproxy"
)

// The observer must work through the policy proxy, which only exposes the
// project's containers and read-only endpoints.
func TestDockerObserverThroughPolicyProxy(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "docker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	labels := func(project, service string) map[string]string {
		return map[string]string{"com.docker.compose.project": project, "com.docker.compose.service": service}
	}
	engine := http.NewServeMux()
	engine.HandleFunc("GET /containers/json", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"Id": "auth1", "Names": []string{"/managed-a-auth"}, "Image": "supabase/gotrue:v2.189.0", "State": "running", "Labels": labels("managed-a", "auth")},
		})
	})
	engine.HandleFunc("GET /containers/auth1/json", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"Config": map[string]any{"Labels": labels("managed-a", "auth")},
			"State":  map[string]any{"Status": "running", "Health": map[string]string{"Status": "healthy"}},
		})
	})
	engine.HandleFunc("GET /info", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"NCPU": 4, "MemTotal": 8 << 30})
	})
	engine.HandleFunc("GET /system/df", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"Volumes": []map[string]any{
			{"Name": "managed-a_managed-db-data", "Driver": "local", "Labels": map[string]string{"com.docker.compose.project": "managed-a", "com.docker.compose.volume": "managed-db-data"}, "UsageData": map[string]int64{"Size": 1024}},
			{"Name": "managed-b_managed-db-data", "Driver": "local", "Labels": map[string]string{"com.docker.compose.project": "managed-b"}, "UsageData": map[string]int64{"Size": 2048}},
		}})
	})
	upstream := &http.Server{Handler: engine}
	go func() { _ = upstream.Serve(listener) }()
	t.Cleanup(func() { _ = upstream.Close() })

	proxy, err := dockerproxy.New(dockerproxy.Config{SocketPath: socket, ComposeProject: "managed-a", Rules: dockerproxy.ReadOnlyInventoryRules()})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(proxy)
	t.Cleanup(server.Close)

	observer := DockerObserver{DockerEndpoint: server.URL + "/", ComposeProject: "managed-a", DatabasePath: t.TempDir()}
	snapshot, err := observer.Observe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Containers) != 1 || snapshot.Containers[0].Service != "auth" || snapshot.Containers[0].Health != "healthy" {
		t.Fatalf("unexpected containers %+v", snapshot.Containers)
	}
	if len(snapshot.Volumes) != 1 || snapshot.Volumes[0].UsedBytes != 1024 || snapshot.Disk.FilesystemUsedBytes != 1024 {
		t.Fatalf("unexpected volumes %+v disk %+v", snapshot.Volumes, snapshot.Disk)
	}
	if snapshot.Compute.CPUCores != 4 {
		t.Fatalf("unexpected compute %+v", snapshot.Compute)
	}
}
