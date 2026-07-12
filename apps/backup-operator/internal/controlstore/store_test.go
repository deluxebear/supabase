package controlstore

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/recoveryexec"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
)

func TestSQLiteTransactionalOutboxAndDeduplicatedResult(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "control.db"), contracts.RecoveryDomain{SystemIdentifier: "control", DataDomain: "control-volume"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	target := contracts.TargetRef{ProjectID: "project", TargetID: "target"}
	if err := store.RegisterTarget(ctx, target, contracts.RecoveryDomain{SystemIdentifier: "managed", DataDomain: "managed-volume"}); err != nil {
		t.Fatal(err)
	}
	operation := contracts.OperationRecord{ID: "job-1", Target: target, IdempotencyKey: "request-1", PlanHash: "hash"}
	if err := store.CreateOperation(ctx, operation); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateOperation(ctx, operation); err != nil {
		t.Fatalf("idempotent create: %v", err)
	}
	now := time.Now()
	err = store.TransitionWithOutbox(ctx,
		contracts.StepTransition{OperationID: "job-1", Step: "dispatch", From: "created", To: "queued", Evidence: contracts.Evidence{ProviderID: "test", ObservationID: "1", ObservedAt: now, ValidUntil: now.Add(time.Minute)}},
		contracts.TaskEnvelope{TaskID: "task-1", OperationID: "job-1", Capability: "inspect", TargetNodeID: "node-1", IdempotencyKey: "dispatch-1"},
	)
	if err != nil {
		t.Fatal(err)
	}
	result := contracts.TaskResult{TaskID: "task-1", Succeeded: true}
	if err := store.RecordTaskResult(ctx, result); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordTaskResult(ctx, result); err != nil {
		t.Fatalf("deduplicated result: %v", err)
	}
	jobs, events, outbox, results, err := store.Counts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if jobs != 1 || events != 1 || outbox != 1 || results != 1 {
		t.Fatalf("unexpected counts: %d %d %d %d", jobs, events, outbox, results)
	}
	replayed, err := store.EventsAfter(ctx, "job-1", 0, 10)
	if err != nil || len(replayed) != 1 || replayed[0].Cursor == 0 {
		t.Fatalf("event replay: %#v %v", replayed, err)
	}
	if again, err := store.EventsAfter(ctx, "job-1", replayed[0].Cursor, 10); err != nil || len(again) != 0 {
		t.Fatalf("event cursor did not advance: %#v %v", again, err)
	}
}

func TestSQLiteRejectsSameRecoveryDomain(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "control.db"), contracts.RecoveryDomain{SystemIdentifier: "same", DataDomain: "control"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	err = store.RegisterTarget(ctx, contracts.TargetRef{ProjectID: "p", TargetID: "t"}, contracts.RecoveryDomain{SystemIdentifier: "same", DataDomain: "managed"})
	if err == nil {
		t.Fatal("expected same system identifier rejection")
	}
}

func TestSQLiteLeaseEnrollmentPlanClaimAndRetention(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "control.db"), contracts.RecoveryDomain{SystemIdentifier: "control", DataDomain: "control"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	base := time.Unix(1_700_000_000, 0)
	store.now = func() time.Time { return base }

	lease, acquired, err := store.AcquireLease(ctx, "cluster/1", "operator-a", time.Minute)
	if err != nil || !acquired || lease.FencingToken != 1 {
		t.Fatalf("first lease: %#v %v %v", lease, acquired, err)
	}
	if _, acquired, err := store.AcquireLease(ctx, "cluster/1", "operator-b", time.Minute); err != nil || acquired {
		t.Fatalf("live lease takeover: %v %v", acquired, err)
	}
	store.now = func() time.Time { return base.Add(2 * time.Minute) }
	lease, acquired, err = store.AcquireLease(ctx, "cluster/1", "operator-b", time.Minute)
	if err != nil || !acquired || lease.FencingToken != 2 {
		t.Fatalf("expired lease takeover: %#v %v %v", lease, acquired, err)
	}

	if err := store.EnrollAgent(ctx, Enrollment{AgentID: "agent", NodeID: "node", CertificateFingerprint: "sha256:one", Capabilities: []string{"inspect"}}); err != nil {
		t.Fatal(err)
	}
	target := contracts.TargetRef{ProjectID: "project", TargetID: "target"}
	if err := store.RegisterTarget(ctx, target, contracts.RecoveryDomain{SystemIdentifier: "managed", DataDomain: "managed"}); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateOperation(ctx, contracts.OperationRecord{ID: "job", Target: target, IdempotencyKey: "key", PlanHash: "hash"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveRestorePlan(ctx, RestorePlanRecord{ID: "plan", JobID: "job", PlanHash: "hash", SafetyInputJSON: `{}`, ExpiresAt: base.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := store.ConfirmRestorePlan(ctx, "plan", "stale-hash", restoreplan.AAL2Assertion{Subject: "user", Authenticated: store.now()}, 5*time.Minute); !errors.Is(err, ErrRestorePlanNotConfirmable) {
		t.Fatalf("expected stale plan confirmation rejection, got %v", err)
	}
	if err := store.ConfirmRestorePlan(ctx, "plan", "hash", restoreplan.AAL2Assertion{Subject: "user", Authenticated: store.now()}, 5*time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateRecoveryExecution(ctx, "plan", "fence-handle", 2); err != nil {
		t.Fatal(err)
	}
	if err := store.Transition(ctx, "plan", recoveryexec.StatePrepared, recoveryexec.StatePostgresStopped, func(record *recoveryexec.Execution) {
		record.OriginalPGDATA = "/data.original"
	}); err != nil {
		t.Fatal(err)
	}
	execution, err := store.Load(ctx, "plan")
	if err != nil || execution.State != recoveryexec.StatePostgresStopped || execution.OriginalPGDATA != "/data.original" {
		t.Fatalf("recovery execution: %#v %v", execution, err)
	}
	if err := store.RegisterQuarantine(ctx, Quarantine{ID: "quarantine", PlanID: "plan", ResourceType: "pgdata", ResourceRef: "/data.original", RollbackUntil: base.Add(3 * time.Minute)}); err != nil {
		t.Fatal(err)
	}
	if items, err := store.ClaimQuarantineCleanup(ctx, "operator", 10); err != nil || len(items) != 0 {
		t.Fatalf("cleanup before retention: %#v %v", items, err)
	}
	store.now = func() time.Time { return base.Add(4 * time.Minute) }
	items, err := store.ClaimQuarantineCleanup(ctx, "operator", 10)
	if err != nil || len(items) != 1 {
		t.Fatalf("cleanup after retention: %#v %v", items, err)
	}
	if err := store.CompleteQuarantineCleanup(ctx, "quarantine", "operator", nil); err != nil {
		t.Fatal(err)
	}
	store.now = func() time.Time { return base.Add(2 * time.Minute) }
	confirmed, err := store.RequireConfirmedRestorePlan(ctx, "plan", "hash", 5*time.Minute)
	if err != nil || confirmed.Subject != "user" {
		t.Fatalf("confirmed plan: %#v %v", confirmed, err)
	}
	store.now = func() time.Time { return base.Add(8 * time.Minute) }
	if _, err := store.RequireConfirmedRestorePlan(ctx, "plan", "hash", 5*time.Minute); !errors.Is(err, ErrRestorePlanNotConfirmed) {
		t.Fatalf("expected confirmation expiry, got %v", err)
	}
	store.now = func() time.Time { return base.Add(2 * time.Minute) }
	if err := store.AppendAudit(ctx, "user", "create", "plan", `{}`); err != nil {
		t.Fatal(err)
	}
	now := store.now()
	if err := store.TransitionWithOutbox(ctx,
		contracts.StepTransition{OperationID: "job", Step: "dispatch", From: "created", To: "queued", Evidence: contracts.Evidence{ProviderID: "test", ObservationID: "1", ObservedAt: now, ValidUntil: now.Add(time.Minute)}},
		contracts.TaskEnvelope{TaskID: "task", OperationID: "job", Capability: "inspect", TargetNodeID: "node", IdempotencyKey: "dispatch"},
	); err != nil {
		t.Fatal(err)
	}
	tasks, err := store.ClaimOutbox(ctx, "dispatcher", 10, time.Minute)
	if err != nil || len(tasks) != 1 || tasks[0].TaskID != "task" {
		t.Fatalf("claim: %#v %v", tasks, err)
	}
	var exported bytes.Buffer
	cursor, err := store.ExportEvents(ctx, &exported, 0, 10)
	if err != nil || cursor == 0 || exported.Len() == 0 {
		t.Fatalf("event export: cursor=%d output=%s err=%v", cursor, exported.String(), err)
	}
	jobEvents, auditEvents, err := store.PruneEvents(ctx, base.Add(3*time.Minute))
	if err != nil || jobEvents != 1 || auditEvents != 1 {
		t.Fatalf("prune: %d %d %v", jobEvents, auditEvents, err)
	}
}

func TestRepositoryIdentityAndCredentialRotation(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "control.db"), contracts.RecoveryDomain{SystemIdentifier: "control", DataDomain: "control"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.RegisterRepository(ctx, RepositoryRecord{ID: "repo", Fingerprint: "fingerprint", Type: "s3", Endpoint: "https://s3.example", EncryptedCredentials: []byte("ciphertext"), KeyID: "key-v1"}); err != nil {
		t.Fatal(err)
	}
	binding := StanzaBinding{RepositoryID: "repo", Stanza: "supabase", SystemIdentifier: "system-1", PostgresMajor: 17, DatabaseHistoryID: "history-1"}
	if err := store.BindStanza(ctx, binding); err != nil {
		t.Fatal(err)
	}
	if err := store.BindStanza(ctx, binding); err != nil {
		t.Fatalf("idempotent binding: %v", err)
	}
	binding.SystemIdentifier = "system-2"
	if !errors.Is(store.BindStanza(ctx, binding), ErrStanzaIdentityConflict) {
		t.Fatal("conflicting system identifier was accepted")
	}
	generation, err := store.RotateRepositoryCredentials(ctx, "repo", "key-v2", []byte("new-ciphertext"), 1)
	if err != nil || generation != 2 {
		t.Fatalf("rotation: %d %v", generation, err)
	}
	if _, err := store.RotateRepositoryCredentials(ctx, "repo", "key-v3", []byte("stale"), 1); err == nil {
		t.Fatal("stale credential rotation was accepted")
	}
}
