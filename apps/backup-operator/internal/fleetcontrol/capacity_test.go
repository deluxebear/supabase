package fleetcontrol

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/fleetproviders"
)

func TestSessionLimiterMeetsThreeHundredAgentEnvelope(t *testing.T) {
	limiter, err := NewSessionLimiter(300)
	if err != nil {
		t.Fatal(err)
	}
	releases := make([]func(), 0, 300)
	for index := 0; index < 300; index++ {
		release, ok := limiter.Acquire(fmt.Sprintf("target-%03d", index%100))
		if !ok {
			t.Fatalf("session %d rejected inside tested envelope", index)
		}
		releases = append(releases, release)
	}
	if _, ok := limiter.Acquire("target-overflow"); ok {
		t.Fatal("session 301 escaped bounded capacity")
	}
	for _, release := range releases {
		release()
	}
	if limiter.Active() != 0 {
		t.Fatalf("active sessions after release = %d", limiter.Active())
	}
}

func TestTwentyConcurrentTargetOperationsMeetAndStopAtEnvelope(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "control"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	for index := 0; index < 21; index++ {
		project := fmt.Sprintf("project-%02d", index)
		target := fmt.Sprintf("target-%02d", index)
		binding := fmt.Sprintf("binding-%02d", index)
		agent := fmt.Sprintf("agent-%02d", index)
		seedHandlerBinding(t, store, project, target, binding, agent, fleetproviders.CapabilityReconcileConfiguration)
		createCapacityOperation(t, store, fmt.Sprintf("op-%02d", index), project, target, binding)
	}
	for index := 0; index < 20; index++ {
		identity := AgentSessionIdentity{AgentID: fmt.Sprintf("agent-%02d", index), ProjectRef: fmt.Sprintf("project-%02d", index), TargetID: fmt.Sprintf("target-%02d", index), BindingID: fmt.Sprintf("binding-%02d", index), Capabilities: []string{fleetproviders.CapabilityReconcileConfiguration}}
		if _, ok, err := store.ClaimOperation(ctx, identity); err != nil || !ok {
			t.Fatalf("claim %d ok=%v err=%v", index, ok, err)
		}
	}
	overflow := AgentSessionIdentity{AgentID: "agent-20", ProjectRef: "project-20", TargetID: "target-20", BindingID: "binding-20", Capabilities: []string{fleetproviders.CapabilityReconcileConfiguration}}
	if _, ok, err := store.ClaimOperation(ctx, overflow); err != nil || ok {
		t.Fatalf("operation 21 ok=%v err=%v", ok, err)
	}
}

func TestHundredProjectControlReadsMeetLatencyAndEventVisibilityEnvelope(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "control"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Now().UTC().UnixMilli()
	for index := 0; index < 100; index++ {
		ref := fmt.Sprintf("project-%03d", index)
		binding := fmt.Sprintf("binding-%03d", index)
		target := fmt.Sprintf("target-%03d", index)
		if _, err := store.db.Exec(`INSERT INTO management_bindings(binding_id,organization_id,project_ref,target_id,execution_target,deployment_kind,allowed_capability_prefixes_json,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,'["runtime."]','active',?,?)`, binding, "org-capacity", ref, target, "compose://"+ref, "compose", now, now); err != nil {
			t.Fatal(err)
		}
	}
	durations := make([]time.Duration, 0, 100)
	for index := 0; index < 100; index++ {
		started := time.Now()
		if _, err := store.GetBindingStatus(ctx, fmt.Sprintf("project-%03d", index), fmt.Sprintf("binding-%03d", index)); err != nil {
			t.Fatal(err)
		}
		durations = append(durations, time.Since(started))
	}
	sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
	if p95 := durations[94]; p95 >= 500*time.Millisecond {
		t.Fatalf("cached control read p95 = %s", p95)
	}
	createCapacityOperation(t, store, "op-visible", "project-000", "target-000", "binding-000")
	visibilityStarted := time.Now()
	events, err := store.ReadEventsAfter(ctx, "op-visible", 0, 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("visible events=%v err=%v", events, err)
	}
	if elapsed := time.Since(visibilityStarted); elapsed >= 5*time.Second {
		t.Fatalf("operation event visibility = %s", elapsed)
	}
}

func TestOperationQuotasAndConcurrencyAreProjectTargetAndOrganizationScoped(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "control"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	policy := DefaultCapacityPolicy()
	policy.MaxConcurrentOperations = 1
	policy.MaxConcurrentPerTarget = 1
	policy.MaxQueuedPerOrganization = 2
	policy.MaxQueuedPerTarget = 1
	if err := store.SetCapacityPolicy(policy); err != nil {
		t.Fatal(err)
	}
	seedHandlerBinding(t, store, "project-a", "target-a", "binding-a", "agent-a", fleetproviders.CapabilityReconcileConfiguration)
	seedHandlerBinding(t, store, "project-b", "target-b", "binding-b", "agent-b", fleetproviders.CapabilityReconcileConfiguration)
	createCapacityOperation(t, store, "op-a", "project-a", "target-a", "binding-a")
	if err := store.CheckOperationQuota(ctx, "org-a", "target-a", "project-a", "new-key"); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("target queue quota error = %v", err)
	}
	if err := store.CheckOperationQuota(ctx, "org-a", "target-a", "project-a", "idem-op-a"); err != nil {
		t.Fatalf("idempotent replay was blocked by quota: %v", err)
	}
	identityA := AgentSessionIdentity{AgentID: "agent-a", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", Capabilities: []string{fleetproviders.CapabilityReconcileConfiguration}}
	if _, ok, err := store.ClaimOperation(ctx, identityA); err != nil || !ok {
		t.Fatalf("first claim ok=%v err=%v", ok, err)
	}
	policy.MaxQueuedPerOrganization = 3
	policy.MaxQueuedPerTarget = 2
	if err := store.SetCapacityPolicy(policy); err != nil {
		t.Fatal(err)
	}
	createCapacityOperation(t, store, "op-a-queued", "project-a", "target-a", "binding-a")
	if _, err := store.db.Exec(`UPDATE operations SET created_at_ms=0 WHERE id='op-a-queued'`); err != nil {
		t.Fatal(err)
	}
	createCapacityOperation(t, store, "op-b", "project-b", "target-b", "binding-b")
	identityB := AgentSessionIdentity{AgentID: "agent-b", ProjectRef: "project-b", TargetID: "target-b", BindingID: "binding-b", Capabilities: []string{fleetproviders.CapabilityReconcileConfiguration}}
	if _, ok, err := store.ClaimOperation(ctx, identityB); err != nil || ok {
		t.Fatalf("global concurrency claim ok=%v err=%v", ok, err)
	}
	if replay, ok, err := store.ClaimOperation(ctx, identityA); err != nil || !ok || replay.ID != "op-a" {
		t.Fatalf("reconnect lost durable active task: %#v ok=%v err=%v", replay, ok, err)
	}
}

func TestRetentionCapsActiveOperationEventsAndArchivesAudit(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "control"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	policy := DefaultCapacityPolicy()
	policy.MaxEventsPerOperation = 100
	policy.AuditRetention = time.Hour
	policy.TerminalEventRetention = time.Hour
	policy.RetentionBatchSize = 1000
	if err := store.SetCapacityPolicy(policy); err != nil {
		t.Fatal(err)
	}
	createCapacityOperation(t, store, "op-a", "project-a", "target-a", "binding-a")
	now := time.Now().UTC().UnixMilli()
	for index := 0; index < 105; index++ {
		if _, err := store.db.Exec(`INSERT INTO operation_events(operation_id,event_type,payload_json,created_at_ms) VALUES(?,'progress','{}',?)`, "op-a", now+int64(index)); err != nil {
			t.Fatal(err)
		}
	}
	store.now = func() time.Time { return time.UnixMilli(now + int64(2*time.Hour/time.Millisecond)) }
	result, err := store.EnforceRetention(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.OperationEventsArchived != 6 || result.AuditEventsArchived != 1 {
		t.Fatalf("retention result = %#v", result)
	}
	var live, archived int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM operation_events WHERE operation_id='op-a'`).Scan(&live); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM operation_event_archive WHERE operation_id='op-a'`).Scan(&archived); err != nil {
		t.Fatal(err)
	}
	if live != 100 || archived != 6 {
		t.Fatalf("live=%d archived=%d", live, archived)
	}
}

func TestArtifactQuotasAreProjectAndOrganizationScopedAndReplaySafe(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "control"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	policy := DefaultCapacityPolicy()
	policy.MaxArtifactBytesPerProject = 10
	policy.MaxArtifactBytesPerOrganization = 15
	if err := store.SetCapacityPolicy(policy); err != nil {
		t.Fatal(err)
	}
	seedHandlerBinding(t, store, "project-a", "target-a", "binding-a", "agent-a", fleetproviders.CapabilityReconcileConfiguration)
	seedHandlerBinding(t, store, "project-b", "target-b", "binding-b", "agent-b", fleetproviders.CapabilityReconcileConfiguration)
	if err := store.RegisterFunctionArtifact(ctx, "project-a", strings.Repeat("a", 64), 10, "user-a", "request-a"); err != nil {
		t.Fatal(err)
	}
	if err := store.RegisterFunctionArtifact(ctx, "project-a", strings.Repeat("a", 64), 10, "user-a", "request-replay"); err != nil {
		t.Fatalf("idempotent artifact replay was blocked: %v", err)
	}
	if err := store.RegisterFunctionArtifact(ctx, "project-a", strings.Repeat("b", 64), 1, "user-a", "request-project-limit"); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("project artifact quota error = %v", err)
	}
	if err := store.RegisterFunctionArtifact(ctx, "project-b", strings.Repeat("c", 64), 6, "user-a", "request-org-limit"); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("organization artifact quota error = %v", err)
	}
	if err := store.RegisterFunctionArtifact(ctx, "project-b", strings.Repeat("d", 64), 5, "user-a", "request-org-boundary"); err != nil {
		t.Fatalf("organization artifact boundary was rejected: %v", err)
	}
}

func createCapacityOperation(t *testing.T, store *Store, id, project, target, binding string) {
	t.Helper()
	document := json.RawMessage(`{"ownershipMode":"observe-only","adapter":"compose","compose":{"files":[]}}`)
	_, created, err := store.CreateOperation(context.Background(), CreateOperationInput{
		Operation:      Operation{ID: id, ProjectRef: project, TargetID: target, BindingID: binding, Domain: "auth", Capability: fleetproviders.CapabilityReconcileConfiguration, ProtocolMajor: 1, ExpectedGeneration: 1, DesiredRevision: "11111111-1111-4111-8111-111111111111", DesiredDigest: strings.Repeat("a", 64), InputSchema: fleetproviders.InputSchemaV1},
		IdempotencyKey: "idem-" + id, TypedInput: document, SnapshotCanonical: string(document), Preconditions: json.RawMessage(`{}`), Actor: "user-a", CorrelationID: "corr-a",
	})
	if err != nil || !created {
		t.Fatalf("create %s created=%v err=%v", id, created, err)
	}
}
