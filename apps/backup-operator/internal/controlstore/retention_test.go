package controlstore

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"
)

func TestRetentionArchivesBeforePruningInBoundedBatches(t *testing.T) {
	store := openOrchestrationStore(t, t.TempDir()+"/retention.db")
	base := time.Unix(1_700_000_000, 0)
	store.now = func() time.Time { return base }
	createTestJob(t, store, "job-retention", "key-retention")
	if err := store.AppendAudit(context.Background(), "owner", "restore.confirm", "job-retention", `{"ok":true}`); err != nil {
		t.Fatal(err)
	}
	store.now = func() time.Time { return base.Add(48 * time.Hour) }
	result, err := store.EnforceRetention(context.Background(), RetentionPolicy{JobEvents: 24 * time.Hour, Audits: 24 * time.Hour, BatchSize: 1})
	if err != nil || result.JobEventsArchived != 1 || result.AuditsArchived != 1 {
		t.Fatalf("retention: %#v %v", result, err)
	}
	for table, want := range map[string]int{"job_events": 0, "audit_events": 0, "job_event_archive": 1, "audit_event_archive": 1} {
		var count int
		if err := store.db.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil || count != want {
			t.Fatalf("%s count=%d want=%d err=%v", table, count, want, err)
		}
	}
	window, err := store.EventCursorWindow(context.Background(), "job-retention")
	if err != nil || window.Earliest != 2 || window.Latest != 1 {
		t.Fatalf("archived cursor boundary was lost: %#v %v", window, err)
	}
}

func TestAuditExportAndCursorSnapshotQueries(t *testing.T) {
	store := openOrchestrationStore(t, t.TempDir()+"/export.db")
	job := createTestJob(t, store, "job-export", "key-export")
	if err := store.AppendAudit(context.Background(), "owner", "restore.confirm", job.ID, `{"ok":true}`); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	last, err := store.ExportAudits(context.Background(), &output, 0, 10)
	if err != nil || last == 0 || !strings.Contains(output.String(), `"stream":"audit"`) || !strings.Contains(output.String(), `"target":"job-export"`) {
		t.Fatalf("audit export: %d %s %v", last, output.String(), err)
	}
	window, err := store.EventCursorWindow(context.Background(), job.ID)
	if err != nil || window.Earliest == 0 || window.Latest < window.Earliest {
		t.Fatalf("cursor window: %#v %v", window, err)
	}
	snapshot, err := store.CurrentJobSnapshot(context.Background(), job.ID)
	if err != nil || snapshot.Cursor != window.Latest || snapshot.State == "" {
		t.Fatalf("snapshot: %#v %v", snapshot, err)
	}
}
