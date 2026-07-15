package fleetcontrol

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/fleetproviders"
)

func TestOperationClaimEnforcesBindingCapabilityAndDurableReplay(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "control"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	seedHandlerBinding(t, store, "project-a", "target-a", "binding-a", "agent-a", fleetproviders.CapabilityReconcileConfiguration)
	document := json.RawMessage(`{"ownershipMode":"observe-only","adapter":"compose","compose":{"files":[{"path":"auth.env","content":"SITE_URL=https://example.test"}]}}`)
	operation, created, err := store.CreateOperation(ctx, CreateOperationInput{
		Operation:      Operation{ID: "op-a", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", Domain: "auth", Capability: fleetproviders.CapabilityReconcileConfiguration, ProtocolMajor: 1, ExpectedGeneration: 1, DesiredRevision: "11111111-1111-4111-8111-111111111111", DesiredDigest: strings.Repeat("a", 64), InputSchema: fleetproviders.InputSchemaV1},
		IdempotencyKey: "idem-a", TypedInput: document, SnapshotCanonical: string(document), Preconditions: json.RawMessage(`{}`), Actor: "user-a", CorrelationID: "corr-a",
	})
	if err != nil || !created || operation.State != "queued" {
		t.Fatalf("create = %#v, created=%v, err=%v", operation, created, err)
	}
	if _, _, err := store.ClaimOperation(ctx, AgentSessionIdentity{AgentID: "agent-a", ProjectRef: "project-b", TargetID: "target-a", BindingID: "binding-a", Capabilities: []string{fleetproviders.CapabilityReconcileConfiguration}}); !errors.Is(err, ErrOperationBinding) {
		t.Fatalf("cross-project claim err = %v", err)
	}
	claimed, ok, err := store.ClaimOperation(ctx, AgentSessionIdentity{AgentID: "agent-a", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", Capabilities: []string{fleetproviders.CapabilityReconcileConfiguration}})
	if err != nil || !ok || claimed.State != "applying" || claimed.TaskID != "op-a:1" || string(claimed.TypedInput) != string(document) {
		t.Fatalf("claim = %#v, ok=%v, err=%v", claimed, ok, err)
	}
	replayed, ok, err := store.ClaimOperation(ctx, AgentSessionIdentity{AgentID: "agent-a", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", Capabilities: []string{fleetproviders.CapabilityReconcileConfiguration}})
	if err != nil || !ok || replayed.TaskID != claimed.TaskID {
		t.Fatalf("reconnect claim = %#v, ok=%v, err=%v", replayed, ok, err)
	}
	evidence := json.RawMessage(`{"schema":"supabase.fleet.runtime.config.evidence.v1","ownershipMode":"direct-managed","adapter":"compose","driftState":"ownership-conflict","applied":false,"observedGeneration":1,"observedDocument":{},"observedDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","conflicts":[{"code":"ownership_conflict","resource":"compose.yaml","message":"owned elsewhere","remediation":"use observe-only"}]}`)
	if err := store.CompleteOperation(ctx, CompleteOperationInput{TaskID: claimed.TaskID, AgentID: "agent-a", Succeeded: false, EvidenceSchema: fleetproviders.EvidenceSchemaV1, Evidence: evidence, ErrorCode: "ownership_conflict"}); err != nil {
		t.Fatal(err)
	}
	completed, _, err := store.GetOperation(ctx, "project-a", "op-a")
	if err != nil || completed.State != "failed" || completed.ErrorCode != "ownership_conflict" || completed.Evidence == nil {
		t.Fatalf("completed operation = %#v, err=%v", completed, err)
	}
	if err := store.CompleteOperation(ctx, CompleteOperationInput{TaskID: claimed.TaskID, AgentID: "agent-a", Succeeded: false, EvidenceSchema: fleetproviders.EvidenceSchemaV1, Evidence: evidence, ErrorCode: "ownership_conflict"}); !errors.Is(err, ErrOperationState) {
		t.Fatalf("duplicate completion err = %v", err)
	}
}
