package fleetcontrol

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/security"
	"github.com/supabase/supabase/apps/backup-operator/internal/version"
)

type Config struct {
	Listen            string
	ShutdownTimeout   time.Duration
	StoreDriver       string
	StoreDSN          string
	StoreIdentity     StoreIdentity
	AssertionKey      []byte
	AssertionIssuer   string
	AssertionAudience string
	AssertionMaxTTL   time.Duration
	Logger            *slog.Logger
}

func (c Config) Validate() error {
	if strings.TrimSpace(c.Listen) == "" || strings.TrimSpace(c.StoreDSN) == "" {
		return errors.New("Fleet listen address and store DSN are required")
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
	var store *Store
	var err error
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
	handler := &Handler{Store: store, Capabilities: NewCapabilityRegistry(), Validator: security.AssertionValidator{Key: cfg.AssertionKey, Issuer: cfg.AssertionIssuer, Audience: cfg.AssertionAudience, MaxTTL: cfg.AssertionMaxTTL}}
	if err := handler.Register(mux); err != nil {
		return err
	}
	listener, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return fmt.Errorf("listen for Fleet Control: %w", err)
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	errCh := make(chan error, 1)
	go func() { errCh <- server.Serve(listener) }()
	cfg.Logger.Info("Fleet Control starting", "listen", cfg.Listen, "api_version", "v1", "schema_version", CurrentSchemaVersion, "build", version.String())
	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown Fleet Control: %w", err)
	}
	return nil
}
