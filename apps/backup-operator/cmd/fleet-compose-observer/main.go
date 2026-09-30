package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/fleetinventory"
)

func main() {
	listen := flag.String("listen", envOr("FLEET_OBSERVER_LISTEN", "0.0.0.0:8093"), "HTTP listen address")
	endpoint := flag.String("docker-endpoint", os.Getenv("FLEET_OBSERVER_DOCKER_ENDPOINT"), "http:// base URL of the policy-limited Fleet Docker proxy; preferred over the raw socket")
	socket := flag.String("docker-socket", envOr("FLEET_OBSERVER_DOCKER_SOCKET", "/var/run/docker.sock"), "Docker Engine Unix socket, used only when no endpoint is set")
	project := flag.String("compose-project", os.Getenv("FLEET_OBSERVER_COMPOSE_PROJECT"), "allowlisted Compose project label")
	databasePath := flag.String("database-path", envOr("FLEET_OBSERVER_DATABASE_PATH", "/inventory/database"), "read-only database volume mount")
	flag.Parse()
	if *project == "" {
		log.Fatal("Fleet observer Compose project is required")
	}
	observer := fleetinventory.DockerObserver{DockerEndpoint: *endpoint, SocketPath: *socket, ComposeProject: *project, DatabasePath: *databasePath}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /v1/inventory", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		snapshot, err := observer.Observe(ctx)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(map[string]string{"code": "inventory_unavailable", "message": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(snapshot)
	})

	if encoded := os.Getenv("FLEET_OBSERVER_JWT_RECIPIENT_PUBLIC_KEY"); encoded != "" {
		public, err := base64.StdEncoding.DecodeString(encoded)
		projectRef, binding := os.Getenv("FLEET_OBSERVER_PROJECT_REF"), os.Getenv("FLEET_OBSERVER_BINDING_ID")
		if err != nil || len(public) != 32 || projectRef == "" || binding == "" {
			log.Fatal("JWT observation requires a recipient key and binding identity")
		}
		mux.HandleFunc("GET /v1/jwt", func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
			defer cancel()
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			report, err := observer.ObserveJWT(ctx, projectRef, binding, public)
			if err != nil {
				w.WriteHeader(http.StatusServiceUnavailable)
				_ = json.NewEncoder(w).Encode(map[string]string{"code": "jwt_observation_unavailable"})
				return
			}
			_ = json.NewEncoder(w).Encode(report)
		})
	}
	server := &http.Server{Addr: *listen, Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("Fleet Compose observer listening on %s", *listen)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
