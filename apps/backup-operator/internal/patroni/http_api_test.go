package patroni

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPAPIReadsClusterConfigAndPauses(t *testing.T) {
	paused := false
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/cluster":
			_, _ = response.Write([]byte(`{"members":[{"name":"node1","role":"leader","state":"running","timeline":3,"lag":0}]}`))
		case "/config":
			if request.Method == http.MethodPatch {
				paused = true
				_, _ = response.Write([]byte(`{}`))
				return
			}
			_, _ = response.Write([]byte(`{"pause":false,"synchronous_mode":true,"synchronous_mode_strict":true}`))
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	api := HTTPAPI{BaseURL: server.URL, Client: server.Client()}
	cluster, err := api.Cluster(context.Background())
	if err != nil || len(cluster.Members) != 1 || cluster.Members[0].Timeline != 3 {
		t.Fatalf("cluster: %#v %v", cluster, err)
	}
	config, err := api.Config(context.Background())
	if err != nil || !config.SynchronousModeStrict {
		t.Fatalf("config: %#v %v", config, err)
	}
	if err := api.SetPaused(context.Background(), true); err != nil || !paused {
		t.Fatalf("pause: %v %v", paused, err)
	}
}

func TestHTTPAPIRejectsInvalidBaseURL(t *testing.T) {
	if _, err := (HTTPAPI{BaseURL: "file:///etc/passwd"}).Cluster(context.Background()); err == nil {
		t.Fatal("expected invalid scheme rejection")
	}
}
