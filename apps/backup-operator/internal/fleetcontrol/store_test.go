package fleetcontrol

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestFleetStoreOwnsIndependentSchemaAndProjectIsolation(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "fleet.db")
	identity := StoreIdentity{SystemIdentifier: "fleet-store", DataDomain: "fleet-volume"}
	store, err := OpenSQLite(ctx, path, identity)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if version, err := store.SchemaVersion(ctx); err != nil || version != CurrentSchemaVersion {
		t.Fatalf("schema version = %d, %v", version, err)
	}
	input := CreateOperationInput{Operation: Operation{ID: "op-a", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", Domain: "runtime", Capability: "runtime.observe", ProtocolMajor: 1, ProtocolMinor: 0, ExpectedGeneration: 7, DesiredRevision: "11111111-1111-4111-8111-111111111111", DesiredDigest: "2a34f64f7cc90fa0edbae5de45ce56f31768e5e68bcae21deec6162c05a826e0", InputSchema: "supabase.fleet.runtime.observe.v1"}, IdempotencyKey: "idem-a", TypedInput: json.RawMessage(`{"services":["auth"]}`), SnapshotCanonical: `{"services":["auth"]}`, Preconditions: json.RawMessage(`{}`), Actor: "user-a", CorrelationID: "request-a"}
	operation, created, err := store.CreateOperation(ctx, input)
	if err != nil || !created {
		t.Fatalf("create operation = %+v, %v, %v", operation, created, err)
	}
	if operation.FencingToken != 1 || operation.State != "queued" {
		t.Fatalf("operation safety metadata = %+v", operation)
	}
	replayed, created, err := store.CreateOperation(ctx, input)
	if err != nil || created || replayed.ID != operation.ID || replayed.FencingToken != operation.FencingToken {
		t.Fatalf("idempotent replay = %+v, %v, %v", replayed, created, err)
	}
	if _, _, err := store.GetOperation(ctx, "project-b", operation.ID); !errors.Is(err, ErrOperationNotFound) {
		t.Fatalf("cross-project read = %v", err)
	}
	if count, err := store.AuditCount(ctx, "project-a"); err != nil || count != 1 {
		t.Fatalf("audit count = %d, %v", count, err)
	}
	events, err := store.ReadEventsAfter(ctx, operation.ID, 0, 10)
	if err != nil || len(events) != 1 || events[0].Type != "operation_queued" {
		t.Fatalf("events = %+v, %v", events, err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenSQLite(ctx, path, StoreIdentity{SystemIdentifier: "managed-stack", DataDomain: "managed-volume"}); err == nil {
		t.Fatal("persisted Fleet store identity mismatch was accepted")
	}
}

func TestFleetMigrationRunnerUpgradesLegacyLedgerAndRejectsChangedChecksum(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "fleet-upgrade.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := fleetMigrations.ReadFile("migrations/sqlite/001_initial.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, string(legacy)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO schema_migrations(version, applied_at_ms) VALUES(1, 1)"); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	identity := StoreIdentity{SystemIdentifier: "fleet-store", DataDomain: "fleet-volume"}
	store, err := OpenSQLite(ctx, path, identity)
	if err != nil {
		t.Fatal(err)
	}
	if version, err := store.SchemaVersion(ctx); err != nil || version != CurrentSchemaVersion {
		t.Fatalf("upgraded schema version = %d, %v", version, err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO schema_migrations(version,name,checksum,applied_at_ms) VALUES(99,'099-removed.sql',?,1)", "0"+strings.Repeat("a", 63)); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenSQLite(ctx, path, identity); !errors.Is(err, ErrMigrationChecksum) {
		t.Fatalf("removed migration error = %v", err)
	}
	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "DELETE FROM schema_migrations WHERE version=99; UPDATE schema_migrations SET checksum='changed' WHERE version=1"); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenSQLite(ctx, path, identity); !errors.Is(err, ErrMigrationChecksum) {
		t.Fatalf("changed migration checksum error = %v", err)
	}
}
