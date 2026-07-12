package agentjournal

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func TestJournalFencingOrphanAndNonTakeover(t *testing.T) {
	ctx := context.Background()
	journal, err := Open(ctx, filepath.Join(t.TempDir(), "journal.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	if disposition, err := journal.Begin(ctx, "task-1", "key-1", 5, true); err != nil || disposition != Started {
		t.Fatalf("begin: %s %v", disposition, err)
	}
	if disposition, err := journal.Begin(ctx, "task-1", "key-1", 5, true); err != nil || disposition != DuplicateRunning {
		t.Fatalf("duplicate: %s %v", disposition, err)
	}
	if count, err := journal.MarkRunningOrphaned(ctx); err != nil || count != 1 {
		t.Fatalf("orphan: %d %v", count, err)
	}
	if _, err := journal.Begin(ctx, "task-1", "key-1", 6, true); !errors.Is(err, ErrOrphaned) {
		t.Fatalf("expected non-takeover orphan: %v", err)
	}
	if _, err := journal.Begin(ctx, "task-2", "key-2", 4, false); !errors.Is(err, ErrStaleFencing) {
		t.Fatalf("expected stale token: %v", err)
	}
	if err := journal.ResolveOrphan(ctx, "task-1", `{"manual":true}`); err != nil {
		t.Fatal(err)
	}
	if disposition, err := journal.Begin(ctx, "task-2", "key-2", 6, true); err != nil || disposition != Started {
		t.Fatalf("new owner after resolution: %s %v", disposition, err)
	}
}

func TestBoundedProgressAndFileLock(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	journal, err := Open(ctx, filepath.Join(dir, "journal.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	for i := 0; i < 5; i++ {
		if err := journal.AppendProgress(ctx, "task", "phase", "message", 3); err != nil {
			t.Fatal(err)
		}
	}
	rows, dropped, err := journal.ProgressStats(ctx)
	if err != nil || rows != 3 || dropped != 2 {
		t.Fatalf("progress stats: %d %d %v", rows, dropped, err)
	}
	path := filepath.Join(dir, "destructive.lock")
	first, err := AcquireFileLock(path)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()
	if _, err := AcquireFileLock(path); !errors.Is(err, ErrDestructiveBusy) {
		t.Fatalf("expected exclusive lock: %v", err)
	}
}

func TestRestartMarksDestructiveExecutionOrphaned(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "journal.db")
	journal, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := journal.Begin(ctx, "task", "key", 1, true); err != nil {
		t.Fatal(err)
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if count, err := reopened.MarkRunningOrphaned(ctx); err != nil || count != 1 {
		t.Fatalf("restart orphan reconciliation: %d %v", count, err)
	}
	if _, err := reopened.Begin(ctx, "task", "key", 2, true); !errors.Is(err, ErrOrphaned) {
		t.Fatalf("restart allowed takeover: %v", err)
	}
}
