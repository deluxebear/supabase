package fleetcontrol

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/fleetdatabase"
)

func TestSensitiveOperationEncryptsDurableInputAndDecryptsOnlyForClaim(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "control"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.ConfigureSensitiveOperationKey([]byte("test-sensitive-operation-key-at-least-32-bytes")); err != nil {
		t.Fatal(err)
	}
	seedHandlerBinding(t, store, "project-a", "target-a", "binding-a", "agent-a", fleetdatabase.CapabilityReconcile)
	plaintext := json.RawMessage(`{"adapter":"compose","ssl":{"enforced":false},"network":{"allowedCidrs":[]},"pooler":{"defaultPoolSize":15,"maxClientConnections":200,"mode":"transaction","ignoredParameters":[]},"rotation":{"role":"primary","currentPassword":"old-password-123","newPassword":"new-password-456"}}`)
	redacted := json.RawMessage(`{"adapter":"compose","ssl":{"enforced":false},"network":{"allowedCidrs":[]},"pooler":{"defaultPoolSize":15,"maxClientConnections":200,"mode":"transaction","ignoredParameters":[]},"rotation":{"role":"primary","currentPassword":"[redacted]","newPassword":"[redacted]"}}`)
	_, created, err := store.CreateOperation(ctx, CreateOperationInput{
		Operation:      Operation{ID: "op-sensitive", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", Domain: "database", Capability: fleetdatabase.CapabilityReconcile, ProtocolMajor: 1, ExpectedGeneration: 1, DesiredRevision: "11111111-1111-4111-8111-111111111111", DesiredDigest: strings.Repeat("a", 64), InputSchema: fleetdatabase.InputSchemaV1},
		IdempotencyKey: "idem-sensitive", TypedInput: plaintext, SnapshotCanonical: string(plaintext), Preconditions: json.RawMessage(`{}`), Actor: "user-a", CorrelationID: "corr-sensitive", Sensitive: true, RedactedTypedInput: redacted, RedactedSnapshotCanonical: string(redacted),
	})
	if err != nil || !created {
		t.Fatalf("create sensitive operation: created=%v err=%v", created, err)
	}
	var storedInput, storedSnapshot string
	var ciphertext []byte
	if err := store.db.QueryRowContext(ctx, "SELECT typed_input_json,snapshot_canonical,input_ciphertext FROM operations WHERE id='op-sensitive'").Scan(&storedInput, &storedSnapshot, &ciphertext); err != nil {
		t.Fatal(err)
	}
	for _, durable := range []string{storedInput, storedSnapshot, string(ciphertext)} {
		if strings.Contains(durable, "old-password-123") || strings.Contains(durable, "new-password-456") {
			t.Fatal("sensitive operation secret was persisted in plaintext")
		}
	}
	claimed, ok, err := store.ClaimOperation(ctx, AgentSessionIdentity{AgentID: "agent-a", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", Capabilities: []string{fleetdatabase.CapabilityReconcile}})
	if err != nil || !ok || string(claimed.TypedInput) != string(plaintext) {
		t.Fatalf("claim sensitive operation = %#v ok=%v err=%v", claimed, ok, err)
	}
}

func TestSensitiveOperationFailsClosedWithoutEncryptionKey(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "control"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	_, _, err = store.CreateOperation(ctx, CreateOperationInput{Operation: Operation{ID: "op", ProjectRef: "project", TargetID: "target", BindingID: "binding", Capability: fleetdatabase.CapabilityReconcile, DesiredRevision: "revision", DesiredDigest: strings.Repeat("a", 64)}, IdempotencyKey: "idem", TypedInput: json.RawMessage(`{"secret":"value"}`), SnapshotCanonical: `{"secret":"value"}`, Preconditions: json.RawMessage(`{}`), Actor: "user", CorrelationID: "corr", Sensitive: true, RedactedTypedInput: json.RawMessage(`{"secret":"[redacted]"}`), RedactedSnapshotCanonical: `{"secret":"[redacted]"}`})
	if err == nil || !strings.Contains(err.Error(), "encryption is not configured") {
		t.Fatalf("missing encryption key error = %v", err)
	}
}
