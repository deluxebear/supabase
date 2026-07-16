package fleetcontrol

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

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
	if err != nil || !ok || claimed.State != "running" || claimed.TaskID != "op-a:1" || claimed.Attempts != 1 || string(claimed.TypedInput) != string(document) {
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
	if err != nil || completed.State != "failed" || completed.ErrorCode != "ownership_conflict" || completed.Evidence == nil || len(completed.AttemptHistory) != 1 || completed.AttemptHistory[0].State != "failed" {
		t.Fatalf("completed operation = %#v, err=%v", completed, err)
	}
	if err := store.CompleteOperation(ctx, CompleteOperationInput{TaskID: claimed.TaskID, AgentID: "agent-a", Succeeded: false, EvidenceSchema: fleetproviders.EvidenceSchemaV1, Evidence: evidence, ErrorCode: "ownership_conflict"}); !errors.Is(err, ErrOperationState) {
		t.Fatalf("duplicate completion err = %v", err)
	}
}

func TestOperationLifecycleSupportsCancelRetryTimeoutAndAttempts(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "control"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	seedHandlerBinding(t, store, "project-a", "target-a", "binding-a", "agent-a", fleetproviders.CapabilityReconcileConfiguration)
	started := time.Date(2026, 7, 16, 8, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return started }
	document := json.RawMessage(`{"ownershipMode":"observe-only","adapter":"compose","compose":{"files":[]}}`)
	create := func(id string) {
		t.Helper()
		_, created, err := store.CreateOperation(ctx, CreateOperationInput{
			Operation:      Operation{ID: id, ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", Domain: "auth", Capability: fleetproviders.CapabilityReconcileConfiguration, ProtocolMajor: 1, ExpectedGeneration: 1, DesiredRevision: "11111111-1111-4111-8111-111111111111", DesiredDigest: strings.Repeat("a", 64), InputSchema: fleetproviders.InputSchemaV1},
			IdempotencyKey: "idem-" + id, TypedInput: document, SnapshotCanonical: string(document), Preconditions: json.RawMessage(`{}`), Actor: "user-a", CorrelationID: "corr-" + id,
		})
		if err != nil || !created {
			t.Fatalf("create %s: created=%v err=%v", id, created, err)
		}
	}

	create("op-cancel")
	if err := store.CancelOperation(ctx, "project-a", "op-cancel", "user-a", "corr-cancel"); err != nil {
		t.Fatal(err)
	}
	cancelled, _, err := store.GetOperation(ctx, "project-a", "op-cancel")
	if err != nil || cancelled.State != "cancelled" || cancelled.Attempts != 0 {
		t.Fatalf("cancelled operation = %#v err=%v", cancelled, err)
	}
	var cancelAudits int
	if err := store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM audit_events WHERE operation_id='op-cancel' AND action='fleet.operation.cancel'").Scan(&cancelAudits); err != nil || cancelAudits != 1 {
		t.Fatalf("cancel audit count = %d err=%v", cancelAudits, err)
	}

	create("op-retry")
	identity := AgentSessionIdentity{AgentID: "agent-a", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", Capabilities: []string{fleetproviders.CapabilityReconcileConfiguration}}
	first, ok, err := store.ClaimOperation(ctx, identity)
	if err != nil || !ok || first.TaskID != "op-retry:1" {
		t.Fatalf("first claim = %#v ok=%v err=%v", first, ok, err)
	}
	if err := store.CancelOperation(ctx, "project-a", "op-retry", "user-a", "corr-running-cancel"); !errors.Is(err, ErrOperationState) {
		t.Fatalf("running cancellation err = %v", err)
	}
	evidence := json.RawMessage(`{"schema":"supabase.fleet.runtime.config.evidence.v1","applied":false}`)
	if err := store.CompleteOperation(ctx, CompleteOperationInput{TaskID: first.TaskID, AgentID: "agent-a", Succeeded: false, EvidenceSchema: fleetproviders.EvidenceSchemaV1, Evidence: evidence, ErrorCode: "provider_failed"}); err != nil {
		t.Fatal(err)
	}
	if err := store.RetryOperation(ctx, "project-a", "op-retry", "user-a", "corr-retry"); err != nil {
		t.Fatal(err)
	}
	var retryAudits int
	if err := store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM audit_events WHERE operation_id='op-retry' AND action='fleet.operation.retry'").Scan(&retryAudits); err != nil || retryAudits != 1 {
		t.Fatalf("retry audit count = %d err=%v", retryAudits, err)
	}
	second, ok, err := store.ClaimOperation(ctx, identity)
	if err != nil || !ok || second.TaskID != "op-retry:2" || second.Attempts != 2 {
		t.Fatalf("second claim = %#v ok=%v err=%v", second, ok, err)
	}
	if err := store.CompleteOperation(ctx, CompleteOperationInput{TaskID: second.TaskID, AgentID: "agent-a", Succeeded: true, EvidenceSchema: fleetproviders.EvidenceSchemaV1, Evidence: json.RawMessage(`{"schema":"supabase.fleet.runtime.config.evidence.v1","applied":true}`)}); err != nil {
		t.Fatal(err)
	}
	succeeded, _, err := store.GetOperation(ctx, "project-a", "op-retry")
	if err != nil || succeeded.State != "succeeded" || succeeded.Attempts != 2 || len(succeeded.AttemptHistory) != 2 || succeeded.AttemptHistory[0].State != "failed" || succeeded.AttemptHistory[1].State != "succeeded" {
		t.Fatalf("succeeded operation = %#v err=%v", succeeded, err)
	}

	create("op-timeout")
	store.now = func() time.Time { return started.Add(operationDeadline + time.Second) }
	timedOut, _, err := store.GetOperation(ctx, "project-a", "op-timeout")
	if err != nil || timedOut.State != "timed_out" || timedOut.ErrorCode != "operation_timed_out" {
		t.Fatalf("timed out operation = %#v err=%v", timedOut, err)
	}
}
