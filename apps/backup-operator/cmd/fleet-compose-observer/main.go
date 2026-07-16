package main

import (
	"context"
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
	socket := flag.String("docker-socket", envOr("FLEET_OBSERVER_DOCKER_SOCKET", "/var/run/docker.sock"), "Docker Engine Unix socket")
	project := flag.String("compose-project", os.Getenv("FLEET_OBSERVER_COMPOSE_PROJECT"), "allowlisted Compose project label")
	databasePath := flag.String("database-path", envOr("FLEET_OBSERVER_DATABASE_PATH", "/inventory/database"), "read-only database volume mount")
	flag.Parse()
	if *project == "" {
		log.Fatal("Fleet observer Compose project is required")
	}
	observer := fleetinventory.DockerObserver{SocketPath: *socket, ComposeProject: *project, DatabasePath: *databasePath}
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
