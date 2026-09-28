package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/dockerproxy"
	"github.com/supabase/supabase/apps/backup-operator/internal/version"
)

func main() {
	listen := flag.String("listen", envOr("FLEET_DOCKER_PROXY_LISTEN", "0.0.0.0:2375"), "HTTP listen address")
	socket := flag.String("docker-socket", envOr("FLEET_DOCKER_PROXY_SOCKET", "/var/run/docker.sock"), "Docker Engine Unix socket")
	project := flag.String("compose-project", os.Getenv("FLEET_DOCKER_PROXY_COMPOSE_PROJECT"), "only Compose project whose containers are visible")
	policy := flag.String("policy", envOr("FLEET_DOCKER_PROXY_POLICY", "inventory-read"), "Docker API policy: inventory-read")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version.String())
		return
	}
	var rules []dockerproxy.Rule
	switch *policy {
	case "inventory-read":
		rules = dockerproxy.ReadOnlyInventoryRules()
	default:
		log.Fatalf("unsupported Fleet Docker proxy policy %q", *policy)
	}
	proxy, err := dockerproxy.New(dockerproxy.Config{SocketPath: *socket, ComposeProject: *project, Rules: rules})
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{Addr: *listen, Handler: proxy, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("Fleet Docker proxy (%s policy, project %s) listening on %s", *policy, *project, *listen)
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
