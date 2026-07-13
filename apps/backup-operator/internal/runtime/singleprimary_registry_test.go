package runtime

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	operatorapi "github.com/supabase/supabase/apps/backup-operator/internal/api"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
)

type registryProbe struct {
	source operatorapi.RestoreObservationSource
	fail   bool
}

func (p registryProbe) ProbePostgres(context.Context, SinglePrimaryConfig) error {
	if p.fail {
		return os.ErrPermission
	}
	return nil
}
func (p registryProbe) ProbePGBackRest(context.Context, SinglePrimaryConfig) error { return nil }
func (p registryProbe) ProbeFence(context.Context, SinglePrimaryConfig) error      { return nil }
func (p registryProbe) BuildSource(SinglePrimaryConfig) (operatorapi.RestoreObservationSource, error) {
	return p.source, nil
}
func TestSinglePrimaryRegistryOnlyEnablesAfterCompleteProbes(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "pgbackrest")
	secret := filepath.Join(dir, "secret.env")
	wal := filepath.Join(dir, "wal.json")
	if err := os.WriteFile(binary, []byte("x"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(secret, []byte("REF=x"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(wal, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg := SinglePrimaryConfig{ProjectID: "p", TargetID: "t", NodeID: "n", PostgresDSN: "host=/run/postgresql", PGBackRestBinary: binary, Stanza: "db", RepositoryID: "repo", RepositoryFingerprint: "fp", RepositoryRevision: "rev", CapacityPath: dir, FenceAdapter: "systemd", SecretRefFile: secret, WALInventoryFile: wal}
	source := staticSource{}
	if result := ConfigureSinglePrimary(context.Background(), cfg, registryProbe{source: source}); result.Source == nil || len(result.Blockers) > 0 {
		t.Fatalf("unexpected blockers: %v", result.Blockers)
	}
	if result := ConfigureSinglePrimary(context.Background(), cfg, registryProbe{source: source, fail: true}); result.Source != nil || len(result.Blockers) == 0 {
		t.Fatal("failed startup probe enabled destructive restore")
	}
}

type staticSource struct{}

func (staticSource) Observe(context.Context, string, time.Time) (restoreplan.Request, error) {
	return restoreplan.Request{}, nil
}
