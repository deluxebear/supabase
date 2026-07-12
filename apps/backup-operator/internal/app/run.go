package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

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

type Config struct {
	Mode   Mode
	Listen string
	Logger *slog.Logger
}

func Run(ctx context.Context, cfg Config) error {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	cfg.Logger.Info("backup operator starting", "mode", cfg.Mode, "version", version.String())

	if cfg.Mode == ModeAgent {
		<-ctx.Done()
		return nil
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "version": version.String()})
	})
	mux.HandleFunc("GET /v1/capabilities", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"name": "read-only-discovery", "supported": true},
			{"name": "single-primary-pgbackrest", "supported": true},
			{"name": "patroni-pgbackrest", "supported": true},
			{"name": "custom-postgres-kubernetes", "supported": true},
			{
				"name":      "cloudnativepg-cnpg-i",
				"supported": true,
				"blocker":   "runtime-disabled unless CloudNativePG ownership and independent CNPG-I prerequisites are positively observed",
			},
			{
				"name":      "destructive-restore",
				"supported": true,
				"blocker":   "each target still requires a fresh plan hash, AAL2 confirmation, write fence, capacity check, repository evidence, and version pin",
			},
		})
	})

	server := &http.Server{Addr: cfg.Listen, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	errCh := make(chan error, 1)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	case err := <-errCh:
		return err
	}
}
