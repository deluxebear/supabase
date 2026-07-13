package runtime

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	operatorapi "github.com/supabase/supabase/apps/backup-operator/internal/api"
	"github.com/supabase/supabase/apps/backup-operator/internal/observation"
)

type LocalSourceFactory func(SinglePrimaryConfig, observation.Snapshot, int64) (operatorapi.RestoreObservationSource, error)
type LocalSinglePrimaryProbe struct {
	HTTP          *http.Client
	HealthURLs    []string
	Run           func(context.Context, string, ...string) error
	SourceFactory LocalSourceFactory
	Now           func() time.Time
	snapshot      observation.Snapshot
	available     int64
}

func (p *LocalSinglePrimaryProbe) Snapshot() observation.Snapshot { return p.snapshot }
func (p *LocalSinglePrimaryProbe) AvailableBytes() int64          { return p.available }

func (p *LocalSinglePrimaryProbe) ProbePostgres(ctx context.Context, c SinglePrimaryConfig) error {
	db, err := sql.Open("pgx", c.PostgresDSN)
	if err != nil {
		return err
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	snap, err := (observation.Observer{DB: db, Runner: observation.ExecRunner{}, BinaryPath: c.PGBackRestBinary, Stanza: c.Stanza, Now: p.Now}).Observe(ctx)
	if err != nil {
		return err
	}
	if snap.PostgreSQL.InRecovery {
		return errors.New("configured single-primary target reports recovery mode")
	}
	p.snapshot = snap
	return nil
}
func (p *LocalSinglePrimaryProbe) ProbePGBackRest(ctx context.Context, c SinglePrimaryConfig) error {
	if !p.snapshot.PgBackRest.CheckOK {
		return errors.New("pgBackRest typed check failed")
	}
	var fs syscall.Statfs_t
	if err := syscall.Statfs(c.CapacityPath, &fs); err != nil {
		return err
	}
	p.available = int64(fs.Bavail) * int64(fs.Bsize)
	if p.available <= 0 {
		return errors.New("capacity path has no available bytes")
	}
	return nil
}
func (p *LocalSinglePrimaryProbe) ProbeFence(ctx context.Context, c SinglePrimaryConfig) error {
	var command string
	var args []string
	switch c.FenceAdapter {
	case "systemd":
		command = "/bin/systemctl"
		args = []string{"is-active", "postgresql"}
	case "compose":
		command = "/usr/bin/docker"
		args = []string{"compose", "ps", "--status", "running"}
	default:
		return errors.New("fence adapter must be systemd or compose")
	}
	run := p.Run
	if run == nil {
		run = func(ctx context.Context, path string, args ...string) error {
			return exec.CommandContext(ctx, path, args...).Run()
		}
	}
	if err := run(ctx, command, args...); err != nil {
		return fmt.Errorf("fence control-plane probe: %w", err)
	}
	client := p.HTTP
	if client == nil {
		client = &http.Client{Timeout: 3 * time.Second}
	}
	for _, url := range p.HealthURLs {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		response, err := client.Do(request)
		if err != nil {
			return fmt.Errorf("data-plane health probe: %w", err)
		}
		response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return fmt.Errorf("data-plane health probe returned %d", response.StatusCode)
		}
	}
	if len(p.HealthURLs) == 0 {
		return errors.New("at least one typed data-plane health endpoint is required")
	}
	return nil
}
func (p *LocalSinglePrimaryProbe) BuildSource(c SinglePrimaryConfig) (operatorapi.RestoreObservationSource, error) {
	if p.SourceFactory == nil {
		return nil, errors.New("local restore observation source factory is not configured")
	}
	return p.SourceFactory(c, p.snapshot, p.available)
}
