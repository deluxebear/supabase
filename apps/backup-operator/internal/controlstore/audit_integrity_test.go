package controlstore

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestAuditHighLoadExportAndRetentionPreserveAppendOnlyPayloads(t *testing.T) {
	store := openOrchestrationStore(t, t.TempDir()+"/audit-integrity.db")
	base := time.Unix(1_700_000_000, 0)
	store.now = func() time.Time { return base }
	const total = 1000
	for i := 0; i < total; i++ {
		if err := store.AppendAudit(context.Background(), "load-test", "restore.execute", fmt.Sprintf("job-%04d", i), fmt.Sprintf(`{"sequence":%d}`, i)); err != nil {
			t.Fatal(err)
		}
	}
	var exported bytes.Buffer
	last, err := store.ExportAudits(context.Background(), &exported, 0, total)
	if err != nil || last != total || strings.Count(exported.String(), `"stream":"audit"`) != total {
		t.Fatalf("bounded audit export lost records: last=%d count=%d err=%v", last, strings.Count(exported.String(), `"stream":"audit"`), err)
	}
	var before string
	if err := store.db.QueryRow(`SELECT group_concat(id || ':' || actor || ':' || action || ':' || target || ':' || payload_json, '|') FROM audit_events ORDER BY id`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	store.now = func() time.Time { return base.Add(48 * time.Hour) }
	archived := int64(0)
	for archived < total {
		result, err := store.EnforceRetention(context.Background(), RetentionPolicy{JobEvents: 24 * time.Hour, Audits: 24 * time.Hour, BatchSize: 37})
		if err != nil {
			t.Fatal(err)
		}
		if result.AuditsArchived == 0 {
			t.Fatalf("retention stopped early at %d", archived)
		}
		archived += result.AuditsArchived
	}
	var after string
	if err := store.db.QueryRow(`SELECT group_concat(id || ':' || actor || ':' || action || ':' || target || ':' || payload_json, '|') FROM audit_event_archive ORDER BY id`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("archive-before-delete changed append-only audit payloads or order")
	}
}
