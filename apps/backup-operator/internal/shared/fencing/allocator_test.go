package fencing

import (
	"context"
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

func TestAllocatorIsMonotonicPerDomainAndIdempotentPerTask(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE fencing_counters(domain_key TEXT PRIMARY KEY,current_token INTEGER NOT NULL); CREATE TABLE task_fencing_tokens(task_id TEXT PRIMARY KEY,domain_key TEXT NOT NULL,fencing_token INTEGER NOT NULL,UNIQUE(domain_key,fencing_token));`); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	allocate := func(task, domain string) int64 {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		token, err := (Allocator{Dialect: SQLite}).Allocate(ctx, tx, task, domain)
		if err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		return token
	}
	if token := allocate("task-a", "project/target"); token != 1 {
		t.Fatalf("first token = %d", token)
	}
	if token := allocate("task-a", "project/target"); token != 1 {
		t.Fatalf("idempotent token = %d", token)
	}
	if token := allocate("task-b", "project/target"); token != 2 {
		t.Fatalf("second token = %d", token)
	}
}
