package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	operatorapi "github.com/supabase/supabase/apps/backup-operator/internal/api"
	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/observability"
	"github.com/supabase/supabase/apps/backup-operator/internal/security"
	"github.com/supabase/supabase/apps/backup-operator/internal/version"
)

type Mode string

const (
	ModeOperator Mode = "operator"
	ModeAgent    Mode = "agent"
	ModeAll      Mode = "all"
)

func ParseMode(value string) (Mode, error) {
	mode := Mode(value)
	switch mode {
	case ModeOperator, ModeAgent, ModeAll:
		return mode, nil
	default:
		return "", fmt.Errorf("invalid mode %q", value)
	}
}

type ControlStoreConfig struct {
	Driver           string
	DSN              string
	SystemIdentifier string
	DataDomain       string
}

type Config struct {
	Mode             Mode
	Listen           string
	ShutdownTimeout  time.Duration
	ControlStore     ControlStoreConfig
	Logger           *slog.Logger
	ServiceAssertion ServiceAssertionConfig
	Runtime          RuntimeConfig
	Metrics          *observability.Metrics
}

type ServiceAssertionConfig struct {
	Key              []byte
	Issuer, Audience string
	MaxTTL           time.Duration
}

func (c Config) Validate() error {
	if _, err := ParseMode(string(c.Mode)); err != nil {
		return err
	}
	if c.Mode == ModeAgent {
		return nil
	}
	if strings.TrimSpace(c.Listen) == "" {
		return errors.New("operator listen address is required")
	}
	if c.ShutdownTimeout < 0 {
		return errors.New("shutdown timeout cannot be negative")
	}
	switch c.ControlStore.Driver {
	case "sqlite", "postgres":
	default:
		return fmt.Errorf("unsupported control store driver %q", c.ControlStore.Driver)
	}
	if strings.TrimSpace(c.ControlStore.DSN) == "" {
		return errors.New("control store DSN is required")
	}
	if strings.TrimSpace(c.ControlStore.SystemIdentifier) == "" || strings.TrimSpace(c.ControlStore.DataDomain) == "" {
		return errors.New("control store recovery-domain identity is required")
	}
	if len(c.ServiceAssertion.Key) < 32 || strings.TrimSpace(c.ServiceAssertion.Issuer) == "" || strings.TrimSpace(c.ServiceAssertion.Audience) == "" {
		return errors.New("service assertion key (at least 32 bytes), issuer, and audience are required")
	}
	return nil
}

type Store interface {
	Close() error
}

type StoreOpener func(context.Context, ControlStoreConfig) (Store, error)

type Worker interface {
	Name() string
	Run(context.Context) error
}

type Dependencies struct {
	OpenStore                 StoreOpener
	Workers                   []Worker
	WorkerFactory             func(Store) ([]Worker, error)
	RuntimeWorkerFactory      func(Config, Store) ([]Worker, bool, error)
	Listen                    func(network, address string) (net.Listener, error)
	RegisterRoutes            func(*http.ServeMux, Store) error
	RestoreObservations       operatorapi.RestoreObservationSource
	RestoreObservationFactory func(Store) (operatorapi.RestoreObservationSource, error)
	Recoverability            operatorapi.RecoverabilitySource
	RecoverabilityFactory     func(Store) (operatorapi.RecoverabilitySource, error)
	ClusterDiscovery          operatorapi.ClusterDiscoverySource
	PITRManager               operatorapi.PITRManager
	ManagementFactory         func(Store) (operatorapi.ClusterDiscoverySource, operatorapi.PITRManager, error)
	ProviderRegistry          *ProviderRegistry
}

func DefaultDependencies(runtime ...RuntimeProviders) Dependencies {
	deps := Dependencies{
		OpenStore: openControlStore,
		Listen:    net.Listen,
		RegisterRoutes: func(mux *http.ServeMux, store Store) error {
			control, ok := store.(*controlstore.Store)
			if !ok {
				return errors.New("default API requires a control store")
			}
			handler, err := operatorapi.NewHandler(control)
			if err != nil {
				return err
			}
			handler.Register(mux)
			return nil
		},
		ProviderRegistry: NewProviderRegistry(),
	}
	if len(runtime) > 0 {
		deps.RuntimeWorkerFactory = defaultRuntimeWorkerFactory(runtime[0])
	}
	return deps
}

func openControlStore(ctx context.Context, cfg ControlStoreConfig) (Store, error) {
	identity := contracts.RecoveryDomain{SystemIdentifier: cfg.SystemIdentifier, DataDomain: cfg.DataDomain}
	if cfg.Driver == "postgres" {
		return controlstore.OpenPostgres(ctx, cfg.DSN, identity)
	}
	return controlstore.OpenSQLite(ctx, cfg.DSN, identity)
}

func Run(ctx context.Context, cfg Config) error {
	return RunWithDependencies(ctx, cfg, DefaultDependencies())
}

func RunWithDependencies(ctx context.Context, cfg Config, deps Dependencies) error {
	if cfg.ShutdownTimeout == 0 {
		cfg.ShutdownTimeout = 10 * time.Second
	}
	if err := cfg.Validate(); err != nil {
		return fmt.Errorf("validate configuration: %w", err)
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Metrics == nil {
		cfg.Metrics = &observability.Metrics{}
	}
	if deps.Listen == nil {
		deps.Listen = net.Listen
	}
	cfg.Logger.Info("backup operator starting", "mode", cfg.Mode, "version", version.String())

	if cfg.Mode == ModeAgent {
		return runWorkers(ctx, cfg.Logger, deps.Workers)
	}
	if deps.OpenStore == nil {
		return errors.New("control store opener is not configured")
	}
	store, err := deps.OpenStore(ctx, cfg.ControlStore)
	if err != nil {
		return fmt.Errorf("initialize control store: %w", err)
	}
	defer func() {
		if err := store.Close(); err != nil {
			cfg.Logger.Error("close control store", "error", err)
		}
	}()
	if deps.RestoreObservationFactory != nil {
		source, sourceErr := deps.RestoreObservationFactory(store)
		if sourceErr != nil {
			return fmt.Errorf("configure restore observations: %w", sourceErr)
		}
		deps.RestoreObservations = source
	}
	if deps.RecoverabilityFactory != nil {
		source, sourceErr := deps.RecoverabilityFactory(store)
		if sourceErr != nil {
			return fmt.Errorf("configure recoverability projection: %w", sourceErr)
		}
		deps.Recoverability = source
	}
	if deps.ManagementFactory != nil {
		discovery, pitr, sourceErr := deps.ManagementFactory(store)
		if sourceErr != nil {
			return fmt.Errorf("configure management sources: %w", sourceErr)
		}
		deps.ClusterDiscovery, deps.PITRManager = discovery, pitr
	}
	runtimeWorkers := append([]Worker(nil), deps.Workers...)
	runtimeConfigured := false
	if deps.WorkerFactory != nil {
		created, err := deps.WorkerFactory(store)
		if err != nil {
			return fmt.Errorf("configure runtime workers: %w", err)
		}
		runtimeWorkers = append(runtimeWorkers, created...)
	}
	if deps.RuntimeWorkerFactory != nil {
		created, configured, err := deps.RuntimeWorkerFactory(cfg, store)
		if err != nil {
			return fmt.Errorf("configure default runtime workers: %w", err)
		}
		runtimeConfigured = configured
		runtimeWorkers = append(runtimeWorkers, created...)
	}

	listener, err := deps.Listen("tcp", cfg.Listen)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", cfg.Listen, err)
	}
	ready := &atomic.Bool{}
	mux := newMux(ready, deps.RestoreObservations != nil, runtimeConfigured, deps.ProviderRegistry)
	if deps.RestoreObservations != nil || deps.Recoverability != nil || deps.ClusterDiscovery != nil || deps.PITRManager != nil {
		control, ok := store.(*controlstore.Store)
		if !ok {
			_ = listener.Close()
			return errors.New("restore observations require a control store")
		}
		handler, routeErr := operatorapi.NewHandlerWithManagementSources(control, deps.RestoreObservations, deps.Recoverability, deps.ClusterDiscovery, deps.PITRManager)
		if routeErr != nil {
			_ = listener.Close()
			return routeErr
		}
		handler.Register(mux)
		deps.RegisterRoutes = nil
	}
	if deps.RegisterRoutes != nil {
		if err := deps.RegisterRoutes(mux, store); err != nil {
			_ = listener.Close()
			return fmt.Errorf("register management API: %w", err)
		}
	}
	secured := operatorapi.Correlate(operatorapi.Authenticate(operatorapi.RequireIdempotency(mux), security.AssertionValidator{Key: cfg.ServiceAssertion.Key, Issuer: cfg.ServiceAssertion.Issuer, Audience: cfg.ServiceAssertion.Audience, MaxTTL: cfg.ServiceAssertion.MaxTTL}))
	root := http.NewServeMux()
	root.Handle("GET /healthz", mux)
	root.Handle("GET /readyz", mux)
	root.Handle("GET /metrics", observability.MetricsHandler(cfg.Metrics))
	root.Handle("/", secured)
	server := &http.Server{Handler: root, ReadHeaderTimeout: 5 * time.Second}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	errCh := make(chan error, len(runtimeWorkers)+1)
	var workers sync.WaitGroup
	for _, worker := range runtimeWorkers {
		worker := worker
		workers.Add(1)
		go func() {
			defer workers.Done()
			if err := worker.Run(runCtx); err != nil && !errors.Is(err, context.Canceled) {
				errCh <- fmt.Errorf("worker %s: %w", worker.Name(), err)
			} else if runCtx.Err() == nil {
				errCh <- fmt.Errorf("worker %s stopped unexpectedly", worker.Name())
			}
		}()
	}
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("serve management API: %w", err)
		}
	}()
	ready.Store(true)

	var runErr error
	select {
	case <-ctx.Done():
	case runErr = <-errCh:
	}
	ready.Store(false)
	cancel()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer shutdownCancel()
	if err := server.Shutdown(shutdownCtx); err != nil && runErr == nil {
		runErr = fmt.Errorf("shutdown management API: %w", err)
	}
	_ = listener.Close()
	workersDone := make(chan struct{})
	go func() {
		workers.Wait()
		close(workersDone)
	}()
	select {
	case <-workersDone:
	case <-shutdownCtx.Done():
		if runErr == nil {
			runErr = errors.New("workers did not stop before shutdown timeout")
		}
	}
	return runErr
}

func runWorkers(ctx context.Context, logger *slog.Logger, workers []Worker) error {
	if len(workers) == 0 {
		<-ctx.Done()
		return nil
	}
	errCh := make(chan error, len(workers))
	for _, worker := range workers {
		worker := worker
		go func() {
			if err := worker.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				errCh <- fmt.Errorf("worker %s: %w", worker.Name(), err)
			} else if ctx.Err() == nil {
				errCh <- fmt.Errorf("worker %s stopped unexpectedly", worker.Name())
			}
		}()
	}
	select {
	case <-ctx.Done():
		logger.Info("workers stopped")
		return nil
	case err := <-errCh:
		return err
	}
}

func newMux(ready *atomic.Bool, configured ...any) *http.ServeMux {
	destructive := len(configured) > 0 && configured[0] == true
	runtimeConfigured := len(configured) > 1 && configured[1] == true
	var registry *ProviderRegistry
	if len(configured) > 2 {
		registry, _ = configured[2].(*ProviderRegistry)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": version.String()})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !ready.Load() {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready", "version": version.String()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": version.String()})
	})
	mux.HandleFunc("GET /v1/capabilities", func(w http.ResponseWriter, _ *http.Request) {
		capabilities := []map[string]any{
			{"name": "durable-control-store", "supported": true},
			{"name": "operator-runtime", "supported": runtimeConfigured, "blocker": map[bool]string{true: "", false: "runtime providers or in-process Agent execution are incomplete"}[runtimeConfigured]},
		}
		for _, provider := range registry.Snapshot() {
			capabilities = append(capabilities, map[string]any{"name": provider.Name, "supported": provider.Supported, "blocker": provider.Blocker})
		}
		capabilities = append(capabilities, map[string]any{"name": "destructive-restore", "supported": destructive, "blocker": map[bool]string{true: "", false: "complete restore observation providers are not configured"}[destructive]})
		writeJSON(w, http.StatusOK, capabilities)
	})
	return mux
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
