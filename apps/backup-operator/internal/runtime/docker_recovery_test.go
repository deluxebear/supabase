package runtime

import (
	"context"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

func TestDockerRecoveryConfigFailsClosedOutsideEnrollment(t *testing.T) {
	base := DockerRecoveryConfig{
		ProjectID: "project", TargetID: "database", NodeID: "node", StatePath: filepath.Join(t.TempDir(), "state.db"),
		DockerSocket: "/var/run/docker.sock", SourceContainer: "database", ValidationContainer: "database-validation", VolumeName: "database-data",
		PGData: "/var/lib/backup-agent/volume/pgdata", ContainerVolumePath: "/var/lib/postgresql", ContainerPGData: "/var/lib/postgresql/pgdata", PostgresDSN: "postgres://source", ValidationDSN: "postgres://validation",
		PGBackRestBinary: "/usr/bin/pgbackrest", PGBackRestConfig: "/etc/pgbackrest/pgbackrest.conf", Stanza: "database",
		RepositoryID: "repository", RepositoryPath: "/var/lib/backup-agent/repository", DatabaseHistory: "1", FenceCommand: "/usr/local/libexec/backup-fence", RollbackWindow: time.Hour,
	}
	if err := validateDockerRecoveryConfig(base); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		mutate func(*DockerRecoveryConfig)
	}{
		{"same validation container", func(c *DockerRecoveryConfig) { c.ValidationContainer = c.SourceContainer }},
		{"container injection", func(c *DockerRecoveryConfig) { c.SourceContainer = "database;rm" }},
		{"volume injection", func(c *DockerRecoveryConfig) { c.VolumeName = "../volume" }},
		{"relative host PGDATA", func(c *DockerRecoveryConfig) { c.PGData = "pgdata" }},
		{"unclean container PGDATA", func(c *DockerRecoveryConfig) { c.ContainerPGData = "/var/lib/../tmp" }},
		{"missing rollback window", func(c *DockerRecoveryConfig) { c.RollbackWindow = 0 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := base
			test.mutate(&candidate)
			if err := validateDockerRecoveryConfig(candidate); err == nil {
				t.Fatal("unsafe Docker recovery configuration accepted")
			}
		})
	}
}

func TestDockerRecoverySideEffectsRemainIdempotentAcrossCrashRestart(t *testing.T) {
	var mu sync.Mutex
	calls := map[string]int{}
	client, err := NewDockerClient(doerFunc(func(request *http.Request) (*http.Response, error) {
		mu.Lock()
		defer mu.Unlock()
		calls[request.URL.Path]++
		status := http.StatusNoContent
		if calls[request.URL.Path] > 1 {
			status = http.StatusNotModified
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(""))}, nil
	}), "http://docker/v1.47", "source", "validation")
	if err != nil {
		t.Fatal(err)
	}
	fs := memoryFS{"/recovery/pgdata": true}
	host := SinglePrimaryHost{Controller: client, ServiceID: "source", FS: fs, PGDataRoot: "/recovery/pgdata", Isolated: fixedDockerRuntime{client: client, container: "validation"}, Validator: validator{}, CutOverValidator: validator{}}
	ctx := context.Background()

	// Each pair represents a process crash after the external side effect but
	// before its durable transition. Re-entry observes 304 or filesystem
	// postconditions and never repeats a destructive mutation ambiguously.
	if err := host.StopPostgres(ctx); err != nil {
		t.Fatal(err)
	}
	if err := host.StopPostgres(ctx); err != nil {
		t.Fatalf("Docker stop crash replay: %v", err)
	}
	quarantine, err := host.QuarantinePGDATA(ctx, "/recovery/pgdata")
	if err != nil {
		t.Fatal(err)
	}
	if replayed, replayErr := host.QuarantinePGDATA(ctx, "/recovery/pgdata"); replayErr != nil || replayed != quarantine {
		t.Fatalf("quarantine crash replay: path=%q err=%v", replayed, replayErr)
	}
	fs["/recovery/pgdata"] = true // pgBackRest side effect completed.
	if err := host.StartIsolated(ctx, "/recovery/pgdata"); err != nil {
		t.Fatal(err)
	}
	if err := host.StartIsolated(ctx, "/recovery/pgdata"); err != nil {
		t.Fatalf("isolated start crash replay: %v", err)
	}
	if err := host.ValidateTarget(ctx, contracts.BackupIdentity{}, contracts.RestoreTarget{}); err != nil {
		t.Fatal(err)
	}
	if err := host.CutOver(ctx, "/recovery/pgdata"); err != nil {
		t.Fatal(err)
	}
	if err := host.CutOver(ctx, "/recovery/pgdata"); err != nil {
		t.Fatalf("cutover crash replay: %v", err)
	}
	delete(fs, "/recovery/pgdata")
	if err := host.RestoreQuarantinedPGDATA(ctx, quarantine, "/recovery/pgdata"); err != nil {
		t.Fatal(err)
	}
	if err := host.RestoreQuarantinedPGDATA(ctx, quarantine, "/recovery/pgdata"); err != nil {
		t.Fatalf("rollback crash replay: %v", err)
	}
}
