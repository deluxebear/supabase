package fleetcontrol

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
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
	input := CreateOperationInput{Operation: Operation{ID: "op-a", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", Domain: "runtime", Capability: "runtime.observe", ProtocolMajor: 1, ProtocolMinor: 0, ExpectedGeneration: 7, InputSchema: "supabase.fleet.runtime.observe.v1"}, IdempotencyKey: "idem-a", TypedInput: json.RawMessage(`{"services":["auth"]}`), Preconditions: json.RawMessage(`{}`), Actor: "user-a", CorrelationID: "request-a"}
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
