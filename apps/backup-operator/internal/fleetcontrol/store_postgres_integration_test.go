package fleetcontrol

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

func TestFleetPostgresStoreCompatibility(t *testing.T) {
	dsn := os.Getenv("FLEET_CONTROL_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("FLEET_CONTROL_TEST_POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	store, err := OpenPostgres(ctx, dsn, StoreIdentity{SystemIdentifier: "fleet-control-test", DataDomain: "fleet-control-test-volume"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	operation, created, err := store.CreateOperation(ctx, CreateOperationInput{Operation: Operation{ID: "postgres-op", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", Domain: "runtime", Capability: "runtime.observe", ProtocolMajor: 1, ProtocolMinor: 0, ExpectedGeneration: 1, DesiredRevision: "11111111-1111-4111-8111-111111111111", DesiredDigest: "2a34f64f7cc90fa0edbae5de45ce56f31768e5e68bcae21deec6162c05a826e0", InputSchema: "supabase.fleet.runtime.observe.v1"}, IdempotencyKey: "postgres-idem", TypedInput: json.RawMessage(`{"services":["auth"]}`), SnapshotCanonical: `{"services":["auth"]}`, Preconditions: json.RawMessage(`{}`), Actor: "integration", CorrelationID: "integration-request"})
	if err != nil || !created || operation.FencingToken != 1 {
		t.Fatalf("PostgreSQL operation = %+v, created=%v, err=%v", operation, created, err)
	}
	var fleetTable, backupTable *string
	if err := store.db.QueryRowContext(ctx, "SELECT to_regclass('public.operations')::text, to_regclass('public.restore_plans')::text").Scan(&fleetTable, &backupTable); err != nil {
		t.Fatal(err)
	}
	if fleetTable == nil || *fleetTable != "operations" || backupTable != nil {
		t.Fatalf("bounded store tables: operations=%v restore_plans=%v", fleetTable, backupTable)
	}
}
