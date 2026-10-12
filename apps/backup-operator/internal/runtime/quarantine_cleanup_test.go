package runtime

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

func TestRemoveQuarantinedPGDATAKeepsTheLiveDataDirectory(t *testing.T) {
	root := t.TempDir()
	live := filepath.Join(root, "data")
	quarantine := live + ".backup-operator-quarantine"
	for _, dir := range []string{live, quarantine} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	remove := RemoveQuarantinedPGDATA(root, live)
	for _, ref := range []string{live, root, filepath.Join(root, "..")} {
		if err := remove(context.Background(), controlstore.Quarantine{ResourceType: "pgdata", ResourceRef: ref}); err == nil {
			t.Fatalf("%s was removed", ref)
		}
	}
	if err := remove(context.Background(), controlstore.Quarantine{ResourceType: "pgdata", ResourceRef: quarantine}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(live); err != nil {
		t.Fatalf("live PGDATA is gone: %v", err)
	}
	if _, err := os.Stat(quarantine); !os.IsNotExist(err) {
		t.Fatalf("quarantine still exists: %v", err)
	}
}

type fakeQuarantineStore struct {
	items     []controlstore.Quarantine
	completed map[string]error
}

func (f *fakeQuarantineStore) ClaimQuarantineCleanup(context.Context, string, int) ([]controlstore.Quarantine, error) {
	claimed := f.items
	f.items = nil
	return claimed, nil
}

func (f *fakeQuarantineStore) CompleteQuarantineCleanup(_ context.Context, id, _ string, err error) error {
	f.completed[id] = err
	return nil
}

func TestQuarantineCleanerRecordsEachResult(t *testing.T) {
	root := t.TempDir()
	expired := filepath.Join(root, "data.backup-operator-quarantine")
	if err := os.Mkdir(expired, 0o700); err != nil {
		t.Fatal(err)
	}
	store := &fakeQuarantineStore{completed: map[string]error{}, items: []controlstore.Quarantine{
		{ID: "plan-a/pgdata", ResourceType: "pgdata", ResourceRef: expired},
		{ID: "plan-b/pgdata", ResourceType: "pgdata", ResourceRef: filepath.Join(root, "data")},
	}}
	cleaner := QuarantineCleaner{Store: store, Remove: RemoveQuarantinedPGDATA(root, filepath.Join(root, "data")), Owner: "agent-node"}
	if err := cleaner.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(expired); !os.IsNotExist(err) {
		t.Fatalf("expired quarantine still exists: %v", err)
	}
	if err, ok := store.completed["plan-a/pgdata"]; !ok || err != nil {
		t.Fatalf("plan-a result = %v", err)
	}
	if store.completed["plan-b/pgdata"] == nil {
		t.Fatal("removing the live PGDATA was recorded as a success")
	}
}

func TestNewRestoreWaitsForAnOpenRollbackWindow(t *testing.T) {
	root := t.TempDir()
	pgdata := filepath.Join(root, "data")
	notStarted := func() error { return os.ErrNotExist }
	started := func() error { return nil }
	if err := checkNoOpenRollbackWindow(pgdata, notStarted); err != nil {
		t.Fatalf("no quarantine: %v", err)
	}
	if err := os.Mkdir(pgdata+".backup-operator-quarantine", 0o700); err != nil {
		t.Fatal(err)
	}
	if err := checkNoOpenRollbackWindow(pgdata, notStarted); err == nil {
		t.Fatal("a new restore was allowed while a rollback window is open")
	}
	if err := checkNoOpenRollbackWindow(pgdata, started); err != nil {
		t.Fatalf("the replay of the restore that made the quarantine was refused: %v", err)
	}
}
