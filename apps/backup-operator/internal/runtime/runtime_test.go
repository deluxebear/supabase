package runtime

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

type unitController struct{ calls []string }

func (c *unitController) StopUnit(_ context.Context, unit string) error {
	c.calls = append(c.calls, "stop:"+unit)
	return nil
}
func (c *unitController) StartUnit(_ context.Context, unit string) error {
	c.calls = append(c.calls, "start:"+unit)
	return nil
}
func (c *unitController) RestartUnit(_ context.Context, unit string) error {
	c.calls = append(c.calls, "restart:"+unit)
	return nil
}

func TestSystemdRejectsUnenrolledUnit(t *testing.T) {
	controller := &unitController{}
	runtime, err := NewSystemd(controller, "postgresql.service")
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.Stop(context.Background(), "ssh.service"); err == nil {
		t.Fatal("unenrolled unit accepted")
	}
	if len(controller.calls) != 0 {
		t.Fatal("controller called for rejected unit")
	}
}

type doerFunc func(*http.Request) (*http.Response, error)

func (f doerFunc) Do(request *http.Request) (*http.Response, error) { return f(request) }

func TestDockerBuildsBoundedEngineAPIRequest(t *testing.T) {
	var request *http.Request
	client, err := NewDockerClient(doerFunc(func(value *http.Request) (*http.Response, error) {
		request = value
		return &http.Response{StatusCode: http.StatusNoContent, Body: io.NopCloser(strings.NewReader(""))}, nil
	}), "http://docker.local/v1.47", "db")
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Stop(context.Background(), "db"); err != nil {
		t.Fatal(err)
	}
	if request.Method != http.MethodPost || request.URL.Path != "/v1.47/containers/db/stop" || request.URL.Query().Get("t") != "30" {
		t.Fatalf("unsafe or incorrect Docker request: %s %s", request.Method, request.URL)
	}
	if err := client.Start(context.Background(), "db;rm"); err == nil {
		t.Fatal("unenrolled container accepted")
	}
}

func TestDockerRequiresExactEnrolledVolumeMountAndTreatsRepeatedActionAsIdempotent(t *testing.T) {
	client, err := NewDockerClient(doerFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method == http.MethodGet && request.URL.Path == "/v1.47/containers/db/json" {
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"Id":"immutable","Mounts":[{"Type":"volume","Name":"database-data","Destination":"/var/lib/postgresql/data","RW":true}]}`))}, nil
		}
		return &http.Response{StatusCode: http.StatusNotModified, Body: io.NopCloser(strings.NewReader(""))}, nil
	}), "http://docker.local/v1.47", "db")
	if err != nil {
		t.Fatal(err)
	}
	if err := client.ValidateVolumeMount(context.Background(), "db", "database-data", "/var/lib/postgresql/data"); err != nil {
		t.Fatal(err)
	}
	if err := client.ValidateVolumeMount(context.Background(), "db", "other-volume", "/var/lib/postgresql/data"); err == nil {
		t.Fatal("unenrolled Docker volume accepted")
	}
	if err := client.ValidateVolumeMount(context.Background(), "db", "database-data", "/tmp/pgdata"); err == nil {
		t.Fatal("unenrolled container PGDATA accepted")
	}
	if err := client.Stop(context.Background(), "db"); err != nil {
		t.Fatalf("repeated Docker stop was not idempotent: %v", err)
	}
}

type memoryFS map[string]bool

func (f memoryFS) Exists(_ context.Context, path string) (bool, error) { return f[path], nil }
func (f memoryFS) Rename(_ context.Context, from, to string) error {
	delete(f, from)
	f[to] = true
	return nil
}

type process struct{}

func (process) Stop(context.Context, string) error    { return nil }
func (process) Start(context.Context, string) error   { return nil }
func (process) Restart(context.Context, string) error { return nil }

type isolated struct{}

func (isolated) Start(context.Context, string) error { return nil }
func (isolated) Stop(context.Context) error          { return nil }

type validator struct{}

func (validator) Validate(context.Context, string, contracts.BackupIdentity, contracts.RestoreTarget) error {
	return nil
}

func TestQuarantineCrashPostconditionAndRollback(t *testing.T) {
	fs := memoryFS{"/data/pg": true}
	host := SinglePrimaryHost{Controller: process{}, ServiceID: "db", FS: fs, PGDataRoot: "/data/pg", Isolated: isolated{}, Validator: validator{}, CutOverValidator: validator{}}
	quarantine, err := host.QuarantinePGDATA(context.Background(), "/data/pg")
	if err != nil {
		t.Fatal(err)
	}
	// Simulate a crash after rename but before the recovery state transition.
	again, err := host.QuarantinePGDATA(context.Background(), "/data/pg")
	if err != nil || again != quarantine {
		t.Fatalf("quarantine was not crash-resumable: path=%q err=%v", again, err)
	}
	if err := host.RestoreQuarantinedPGDATA(context.Background(), quarantine, "/data/pg"); err != nil {
		t.Fatal(err)
	}
	if err := host.RestoreQuarantinedPGDATA(context.Background(), quarantine, "/data/pg"); err != nil {
		t.Fatalf("rollback postcondition was not idempotent: %v", err)
	}
}

func TestPostgresTargetValidatorAllowsPhysicalRecoveryTime(t *testing.T) {
	validator := postgresTargetValidator{}
	if validator.validationTimeout() != 10*time.Minute {
		t.Fatalf("default validation timeout = %s, want 10m", validator.validationTimeout())
	}
	if validator.validationDelay() != 250*time.Millisecond {
		t.Fatalf("default validation delay = %s, want 250ms", validator.validationDelay())
	}
	configured := postgresTargetValidator{timeout: 2 * time.Minute, delay: 10 * time.Millisecond}
	if configured.validationTimeout() != 2*time.Minute || configured.validationDelay() != 10*time.Millisecond {
		t.Fatalf("configured validation timing was ignored: timeout=%s delay=%s", configured.validationTimeout(), configured.validationDelay())
	}
}

func TestIdentityAwareQuarantinePreparesEmptyRestoreAndIsolatesFailedTree(t *testing.T) {
	root := t.TempDir()
	pgdata := filepath.Join(root, "pgdata")
	if err := os.Mkdir(pgdata, 0o710); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pgdata, "PG_VERSION"), []byte("17\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	host := SinglePrimaryHost{Controller: process{}, ServiceID: "db", FS: osFilesystem{}, PGDataRoot: pgdata, Isolated: isolated{}, Validator: validator{}, CutOverValidator: validator{}}
	original, err := host.QuarantinePGDATA(context.Background(), pgdata)
	if err != nil {
		t.Fatal(err)
	}
	if empty, err := (osFilesystem{}).DirectoryEmpty(context.Background(), pgdata); err != nil || !empty {
		t.Fatalf("restore destination is not an empty directory: empty=%v err=%v", empty, err)
	}
	if replayed, err := host.QuarantinePGDATA(context.Background(), pgdata); err != nil || replayed != original {
		t.Fatalf("initial quarantine replay: path=%q err=%v", replayed, err)
	}
	if err := os.WriteFile(filepath.Join(pgdata, "PG_VERSION"), []byte("17\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	failed, err := host.QuarantinePGDATA(context.Background(), pgdata)
	if err != nil || failed != pgdata+".backup-operator-failed" {
		t.Fatalf("failed restore isolation: path=%q err=%v", failed, err)
	}
	if replayed, err := host.QuarantinePGDATA(context.Background(), pgdata); err != nil || replayed != failed {
		t.Fatalf("failed restore isolation replay: path=%q err=%v", replayed, err)
	}
	if err := host.RestoreQuarantinedPGDATA(context.Background(), original, pgdata); err != nil {
		t.Fatal(err)
	}
	if err := host.DiscardFailedPGDATA(context.Background(), failed); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(failed); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed restore tree was not discarded: %v", err)
	}
}

func TestIdentityAwareQuarantineRejectsSymlinkAndMismatchedReplay(t *testing.T) {
	root := t.TempDir()
	real := filepath.Join(root, "real")
	link := filepath.Join(root, "pgdata")
	if err := os.Mkdir(real, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	host := SinglePrimaryHost{Controller: process{}, ServiceID: "db", FS: osFilesystem{}, PGDataRoot: link, Isolated: isolated{}, Validator: validator{}, CutOverValidator: validator{}}
	if _, err := host.QuarantinePGDATA(context.Background(), link); err == nil {
		t.Fatal("symlink PGDATA accepted")
	}

	pgdata := filepath.Join(root, "identity")
	if err := os.Mkdir(pgdata, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pgdata, "PG_VERSION"), []byte("17\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	host.PGDataRoot = pgdata
	if _, err := host.QuarantinePGDATA(context.Background(), pgdata); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(pgdata, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := host.QuarantinePGDATA(context.Background(), pgdata); err == nil {
		t.Fatal("mismatched empty replay directory identity accepted")
	}
}
