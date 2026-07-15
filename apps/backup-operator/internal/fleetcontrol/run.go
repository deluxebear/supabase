package fleetcontrol

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	fleetagentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/fleet/v1"
	"github.com/supabase/supabase/apps/backup-operator/internal/security"
	"github.com/supabase/supabase/apps/backup-operator/internal/version"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

type Config struct {
	Listen                   string
	EnrollmentListen         string
	AgentListen              string
	ShutdownTimeout          time.Duration
	StoreDriver              string
	StoreDSN                 string
	StoreIdentity            StoreIdentity
	AssertionKey             []byte
	AssertionIssuer          string
	AssertionAudience        string
	AssertionMaxTTL          time.Duration
	AgentCACertFile          string
	AgentCAKeyFile           string
	AgentTrustDomain         string
	AgentCertificateTTL      time.Duration
	EnrollmentTokenTTL       time.Duration
	CertificateOverlap       time.Duration
	EnrollmentServerCertFile string
	EnrollmentServerKeyFile  string
	Logger                   *slog.Logger
}

func (c Config) Validate() error {
	if strings.TrimSpace(c.Listen) == "" || strings.TrimSpace(c.EnrollmentListen) == "" || strings.TrimSpace(c.AgentListen) == "" || strings.TrimSpace(c.StoreDSN) == "" {
		return errors.New("Fleet control, enrollment, and Agent listen addresses and store DSN are required")
	}
	if c.Listen == c.EnrollmentListen || c.Listen == c.AgentListen || c.EnrollmentListen == c.AgentListen {
		return errors.New("Fleet control, enrollment, and Agent listeners must be separate")
	}
	if c.StoreDriver != string(FleetSQLite) && c.StoreDriver != string(FleetPostgres) {
		return fmt.Errorf("unsupported Fleet store driver %q", c.StoreDriver)
	}
	if c.StoreIdentity.SystemIdentifier == "" || c.StoreIdentity.DataDomain == "" {
		return errors.New("Fleet store recovery-domain identity is required")
	}
	if len(c.AssertionKey) < 32 || c.AssertionIssuer == "" || c.AssertionAudience == "" {
		return errors.New("Fleet service assertion key (at least 32 bytes), issuer, and audience are required")
	}
	if c.ShutdownTimeout < 0 || c.AssertionMaxTTL <= 0 {
		return errors.New("Fleet shutdown and assertion timeouts are invalid")
	}
	if c.AgentCACertFile == "" || c.AgentCAKeyFile == "" || c.AgentTrustDomain == "" || c.EnrollmentServerCertFile == "" || c.EnrollmentServerKeyFile == "" {
		return errors.New("Fleet Agent CA, trust domain, and enrollment TLS server identity are required")
	}
	if c.AgentCertificateTTL <= 0 || c.AgentCertificateTTL > maximumAgentCertificateTTL || c.EnrollmentTokenTTL <= 0 || c.EnrollmentTokenTTL > time.Hour || c.CertificateOverlap <= 0 || c.CertificateOverlap > time.Hour {
		return errors.New("Fleet Agent certificate, enrollment token, or rotation overlap duration is invalid")
	}
	return nil
}

func Run(ctx context.Context, cfg Config) error {
	if cfg.ShutdownTimeout == 0 {
		cfg.ShutdownTimeout = 10 * time.Second
	}
	if err := cfg.Validate(); err != nil {
		return fmt.Errorf("validate Fleet Control configuration: %w", err)
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	caCertificatePEM, err := os.ReadFile(cfg.AgentCACertFile)
	if err != nil {
		return fmt.Errorf("read Fleet Agent CA certificate: %w", err)
	}
	caPrivateKeyPEM, err := os.ReadFile(cfg.AgentCAKeyFile)
	if err != nil {
		return fmt.Errorf("read Fleet Agent CA private key: %w", err)
	}
	agentCA, err := LoadCertificateAuthority(caCertificatePEM, caPrivateKeyPEM, cfg.AgentTrustDomain, cfg.AgentCertificateTTL)
	if err != nil {
		return fmt.Errorf("load Fleet Agent certificate authority: %w", err)
	}
	serverCertificate, err := tls.LoadX509KeyPair(cfg.EnrollmentServerCertFile, cfg.EnrollmentServerKeyFile)
	if err != nil {
		return fmt.Errorf("load Fleet enrollment server certificate: %w", err)
	}
	clientCAs := x509.NewCertPool()
	if !clientCAs.AppendCertsFromPEM(caCertificatePEM) {
		return errors.New("Fleet Agent CA certificate could not be added to the enrollment client trust pool")
	}
	var store *Store
	err = nil
	if cfg.StoreDriver == string(FleetPostgres) {
		store, err = OpenPostgres(ctx, cfg.StoreDSN, cfg.StoreIdentity)
	} else {
		store, err = OpenSQLite(ctx, cfg.StoreDSN, cfg.StoreIdentity)
	}
	if err != nil {
		return fmt.Errorf("initialize Fleet Control store: %w", err)
	}
	defer store.Close()
	mux := http.NewServeMux()
	handler := &Handler{
		Store: store, Capabilities: NewCapabilityRegistry(),
		Validator: security.AssertionValidator{Key: cfg.AssertionKey, Issuer: cfg.AssertionIssuer, Audience: cfg.AssertionAudience, MaxTTL: cfg.AssertionMaxTTL},
		AgentCA:   agentCA, EnrollmentTokenTTL: cfg.EnrollmentTokenTTL, CertificateOverlap: cfg.CertificateOverlap,
	}
	if err := handler.Register(mux); err != nil {
		return err
	}
	listener, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return fmt.Errorf("listen for Fleet Control: %w", err)
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	enrollmentListener, err := net.Listen("tcp", cfg.EnrollmentListen)
	if err != nil {
		listener.Close()
		return fmt.Errorf("listen for Fleet Agent enrollment: %w", err)
	}
	enrollmentTLS := &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{serverCertificate},
		ClientCAs:    clientCAs,
		ClientAuth:   tls.VerifyClientCertIfGiven,
	}
	enrollmentServer := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, TLSConfig: enrollmentTLS}
	agentListener, err := net.Listen("tcp", cfg.AgentListen)
	if err != nil {
		listener.Close()
		enrollmentListener.Close()
		return fmt.Errorf("listen for Fleet Agent control: %w", err)
	}
	agentTLS := &tls.Config{
		MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{serverCertificate},
		ClientCAs: clientCAs, ClientAuth: tls.RequireAndVerifyClientCert,
	}
	agentGRPC := grpc.NewServer(grpc.Creds(credentials.NewTLS(agentTLS)))
	fleetagentv1.RegisterFleetAgentControlServiceServer(agentGRPC, &AgentServer{Store: store, Authority: agentCA})
	errCh := make(chan error, 3)
	go func() { errCh <- server.Serve(listener) }()
	go func() { errCh <- enrollmentServer.Serve(tls.NewListener(enrollmentListener, enrollmentTLS)) }()
	go func() { errCh <- agentGRPC.Serve(agentListener) }()
	cfg.Logger.Info("Fleet Control starting", "listen", cfg.Listen, "enrollment_listen", cfg.EnrollmentListen, "agent_listen", cfg.AgentListen, "trust_domain", cfg.AgentTrustDomain, "api_version", "v1", "schema_version", CurrentSchemaVersion, "build", version.String())
	var serveErr error
	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			serveErr = err
		}
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown Fleet Control: %w", err)
	}
	if err := enrollmentServer.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown Fleet Agent enrollment: %w", err)
	}
	grpcDone := make(chan struct{})
	go func() { agentGRPC.GracefulStop(); close(grpcDone) }()
	select {
	case <-grpcDone:
	case <-shutdownCtx.Done():
		agentGRPC.Stop()
	}
	return serveErr
}
