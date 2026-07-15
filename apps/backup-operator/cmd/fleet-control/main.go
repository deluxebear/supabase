package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/fleetcontrol"
	"github.com/supabase/supabase/apps/backup-operator/internal/version"
)

func main() {
	listen := flag.String("listen", envOr("FLEET_CONTROL_LISTEN", "127.0.0.1:8090"), "Fleet Control HTTP listen address")
	storeDriver := flag.String("store-driver", envOr("FLEET_CONTROL_STORE_DRIVER", "sqlite"), "Fleet Control store driver: sqlite or postgres")
	storeDSN := flag.String("store-dsn", envOr("FLEET_CONTROL_STORE_DSN", "fleet-control.db"), "Fleet Control store path or PostgreSQL DSN")
	storeSystemID := flag.String("store-system-identifier", envOr("FLEET_CONTROL_STORE_SYSTEM_IDENTIFIER", "fleet-control-local"), "independent Fleet store system identity")
	storeDataDomain := flag.String("store-data-domain", envOr("FLEET_CONTROL_STORE_DATA_DOMAIN", "fleet-control-local"), "independent Fleet store data domain")
	assertionKey := flag.String("service-assertion-key", os.Getenv("FLEET_CONTROL_SERVICE_ASSERTION_KEY"), "Studio-to-Fleet service assertion key")
	assertionIssuer := flag.String("service-assertion-issuer", envOr("FLEET_CONTROL_SERVICE_ASSERTION_ISSUER", "studio-platform"), "service assertion issuer")
	assertionAudience := flag.String("service-assertion-audience", envOr("FLEET_CONTROL_SERVICE_ASSERTION_AUDIENCE", "fleet-control"), "service assertion audience")
	assertionMaxTTL := flag.Duration("service-assertion-max-ttl", envDuration("FLEET_CONTROL_SERVICE_ASSERTION_MAX_TTL", 5*time.Minute), "maximum service assertion lifetime")
	shutdownTimeout := flag.Duration("shutdown-timeout", envDuration("FLEET_CONTROL_SHUTDOWN_TIMEOUT", 10*time.Second), "graceful shutdown timeout")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version.String())
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	err := fleetcontrol.Run(ctx, fleetcontrol.Config{Listen: *listen, ShutdownTimeout: *shutdownTimeout, StoreDriver: *storeDriver, StoreDSN: *storeDSN, StoreIdentity: fleetcontrol.StoreIdentity{SystemIdentifier: *storeSystemID, DataDomain: *storeDataDomain}, AssertionKey: []byte(*assertionKey), AssertionIssuer: *assertionIssuer, AssertionAudience: *assertionAudience, AssertionMaxTTL: *assertionMaxTTL})
	if err != nil {
		log.Fatal(err)
	}
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envDuration(name string, fallback time.Duration) time.Duration {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		if seconds, convErr := strconv.Atoi(value); convErr == nil {
			return time.Duration(seconds) * time.Second
		}
		return fallback
	}
	return parsed
}
