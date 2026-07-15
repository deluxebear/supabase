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
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetplatform"
	"github.com/supabase/supabase/apps/backup-operator/internal/version"
)

func main() {
	mode := flag.String("mode", envOr("FLEET_CONTROL_MODE", "control"), "process mode: control or outbox-dispatcher")
	listen := flag.String("listen", envOr("FLEET_CONTROL_LISTEN", "127.0.0.1:8090"), "Fleet Control HTTP listen address")
	enrollmentListen := flag.String("enrollment-listen", envOr("FLEET_CONTROL_ENROLLMENT_LISTEN", "127.0.0.1:8091"), "Fleet Agent enrollment HTTPS listen address")
	agentListen := flag.String("agent-listen", envOr("FLEET_CONTROL_AGENT_LISTEN", "127.0.0.1:8092"), "Fleet Agent mTLS gRPC listen address")
	storeDriver := flag.String("store-driver", envOr("FLEET_CONTROL_STORE_DRIVER", "sqlite"), "Fleet Control store driver: sqlite or postgres")
	storeDSN := flag.String("store-dsn", envOr("FLEET_CONTROL_STORE_DSN", "fleet-control.db"), "Fleet Control store path or PostgreSQL DSN")
	artifactRoot := flag.String("artifact-root", envOr("FLEET_CONTROL_ARTIFACT_ROOT", "fleet-artifacts"), "project-isolated immutable function artifact root")
	storeSystemID := flag.String("store-system-identifier", envOr("FLEET_CONTROL_STORE_SYSTEM_IDENTIFIER", "fleet-control-local"), "independent Fleet store system identity")
	storeDataDomain := flag.String("store-data-domain", envOr("FLEET_CONTROL_STORE_DATA_DOMAIN", "fleet-control-local"), "independent Fleet store data domain")
	assertionKey := flag.String("service-assertion-key", os.Getenv("FLEET_CONTROL_SERVICE_ASSERTION_KEY"), "Studio-to-Fleet service assertion key")
	assertionIssuer := flag.String("service-assertion-issuer", envOr("FLEET_CONTROL_SERVICE_ASSERTION_ISSUER", "studio-platform"), "service assertion issuer")
	assertionAudience := flag.String("service-assertion-audience", envOr("FLEET_CONTROL_SERVICE_ASSERTION_AUDIENCE", "fleet-control"), "service assertion audience")
	assertionMaxTTL := flag.Duration("service-assertion-max-ttl", envDuration("FLEET_CONTROL_SERVICE_ASSERTION_MAX_TTL", 5*time.Minute), "maximum service assertion lifetime")
	agentCACert := flag.String("agent-ca-cert", os.Getenv("FLEET_CONTROL_AGENT_CA_CERT"), "Agent CA certificate PEM path")
	agentCAKey := flag.String("agent-ca-key", os.Getenv("FLEET_CONTROL_AGENT_CA_KEY"), "Agent CA private key PEM path")
	agentTrustDomain := flag.String("agent-trust-domain", os.Getenv("FLEET_CONTROL_AGENT_TRUST_DOMAIN"), "Agent SPIFFE trust domain")
	agentCertificateTTL := flag.Duration("agent-certificate-ttl", envDuration("FLEET_CONTROL_AGENT_CERTIFICATE_TTL", 24*time.Hour), "short-lived Agent certificate lifetime")
	enrollmentTokenTTL := flag.Duration("enrollment-token-ttl", envDuration("FLEET_CONTROL_ENROLLMENT_TOKEN_TTL", 10*time.Minute), "single-use enrollment token lifetime")
	certificateOverlap := flag.Duration("certificate-overlap", envDuration("FLEET_CONTROL_CERTIFICATE_OVERLAP", 15*time.Minute), "certificate rotation overlap window")
	enrollmentServerCert := flag.String("enrollment-server-cert", os.Getenv("FLEET_CONTROL_ENROLLMENT_SERVER_CERT"), "enrollment HTTPS server certificate PEM path")
	enrollmentServerKey := flag.String("enrollment-server-key", os.Getenv("FLEET_CONTROL_ENROLLMENT_SERVER_KEY"), "enrollment HTTPS server private key PEM path")
	shutdownTimeout := flag.Duration("shutdown-timeout", envDuration("FLEET_CONTROL_SHUTDOWN_TIMEOUT", 10*time.Second), "graceful shutdown timeout")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version.String())
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *mode == "outbox-dispatcher" {
		platformDSN := envOr("FLEET_PLATFORM_STORE_DSN", "")
		store, err := fleetplatform.OpenPostgres(ctx, platformDSN)
		if err != nil {
			log.Fatal(err)
		}
		defer store.Close()
		err = fleetplatform.Run(ctx, fleetplatform.Config{
			Store: store, FleetControlURL: envOr("FLEET_CONTROL_URL", "http://127.0.0.1:8090"),
			AssertionKey: []byte(*assertionKey), AssertionIssuer: *assertionIssuer,
			AssertionAudience: *assertionAudience, WorkerID: envOr("FLEET_OUTBOX_WORKER_ID", "fleet-outbox-1"),
			Lease: envDuration("FLEET_OUTBOX_LEASE", 30*time.Second), PollInterval: envDuration("FLEET_OUTBOX_POLL_INTERVAL", 2*time.Second),
		})
		if err != nil {
			log.Fatal(err)
		}
		return
	}
	if *mode != "control" {
		log.Fatalf("unsupported Fleet Control mode %q", *mode)
	}
	err := fleetcontrol.Run(ctx, fleetcontrol.Config{
		Listen: *listen, EnrollmentListen: *enrollmentListen, AgentListen: *agentListen, ShutdownTimeout: *shutdownTimeout,
		StoreDriver: *storeDriver, StoreDSN: *storeDSN, ArtifactRoot: *artifactRoot,
		StoreIdentity: fleetcontrol.StoreIdentity{SystemIdentifier: *storeSystemID, DataDomain: *storeDataDomain},
		AssertionKey:  []byte(*assertionKey), AssertionIssuer: *assertionIssuer, AssertionAudience: *assertionAudience, AssertionMaxTTL: *assertionMaxTTL,
		AgentCACertFile: *agentCACert, AgentCAKeyFile: *agentCAKey, AgentTrustDomain: *agentTrustDomain,
		AgentCertificateTTL: *agentCertificateTTL, EnrollmentTokenTTL: *enrollmentTokenTTL, CertificateOverlap: *certificateOverlap,
		EnrollmentServerCertFile: *enrollmentServerCert, EnrollmentServerKeyFile: *enrollmentServerKey,
	})
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
