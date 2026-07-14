package runtime

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/pgbackrest"
	"github.com/supabase/supabase/apps/backup-operator/internal/recoverability"
)

func TestPOSIXWALInventoryRequiresExplicitOwnerOnlyMetadata(t *testing.T) {
	now := time.Now().UTC()
	path := filepath.Join(t.TempDir(), "wal.json")
	payload, _ := json.Marshal(WALInventory{RepositoryFingerprint: "fp", RepositoryRevision: "rev", DatabaseHistoryID: 7, CurrentTimeline: 1, Segments: []recoverability.ArchiveSegment{{Name: "000000010000000000000001", RecoverableThrough: now}}})
	if err := os.WriteFile(path, payload, 0600); err != nil {
		t.Fatal(err)
	}
	source := POSIXWALSource{InventoryFile: path, Stanza: "db", Info: []pgbackrest.StanzaInfo{{Name: "db", SystemID: 42, Backups: []pgbackrest.BackupInfo{{Label: "backup", ArchiveStart: "000000010000000000000001", ArchiveStop: "000000010000000000000001", StartedAt: now.Add(-time.Hour), StoppedAt: now.Add(-time.Minute)}}}}}
	if _, err := source.ObserveWAL(context.Background(), controlstore.BackupManifestRecord{BackupLabel: "backup"}); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := source.ObserveWAL(context.Background(), controlstore.BackupManifestRecord{BackupLabel: "backup"}); err == nil {
		t.Fatal("world-readable inventory accepted")
	}
}

func TestPOSIXWALInventoryReportsEmptyAndInvalidFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wal.json")
	source := POSIXWALSource{InventoryFile: path}
	manifest := controlstore.BackupManifestRecord{BackupLabel: "backup"}

	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := source.ObserveWAL(context.Background(), manifest); err == nil || err.Error() != "WAL inventory is empty" {
		t.Fatalf("empty inventory error = %v", err)
	}

	if err := os.WriteFile(path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := source.ObserveWAL(context.Background(), manifest); err == nil || !strings.HasPrefix(err.Error(), "WAL inventory contains invalid JSON:") {
		t.Fatalf("invalid inventory error = %v", err)
	}
}
