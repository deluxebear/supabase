package controlstore

import (
	"context"
	"strconv"
	"strings"
	"testing"
)

func TestSQLiteDiskFullFailsWithoutLosingCommittedAudit(t *testing.T) {
	store := openOrchestrationStore(t, t.TempDir()+"/disk-full.db")
	if err := store.AppendAudit(context.Background(), "operator", "before-full", "job", `{}`); err != nil {
		t.Fatal(err)
	}
	var pages int
	if err := store.db.QueryRow(`PRAGMA page_count`).Scan(&pages); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`PRAGMA max_page_count = ` + strconv.Itoa(pages)); err != nil {
		t.Fatal(err)
	}
	err := store.AppendAudit(context.Background(), "operator", "fills-disk", "job", `{"payload":"`+strings.Repeat("x", 2<<20)+`"}`)
	if err == nil {
		t.Fatal("expected SQLITE_FULL")
	}
	var count int
	if queryErr := store.db.QueryRow(`SELECT count(*) FROM audit_events WHERE action='before-full'`).Scan(&count); queryErr != nil || count != 1 {
		t.Fatalf("committed audit was lost after SQLITE_FULL: count=%d err=%v", count, queryErr)
	}
}
