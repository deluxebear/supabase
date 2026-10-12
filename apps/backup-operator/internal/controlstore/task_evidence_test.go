package controlstore

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func createCapabilityJob(t *testing.T, store *Store, id, target, capability string) {
	t.Helper()
	if _, _, err := store.CreateJob(context.Background(), CreateJobInput{
		ID: id, ProjectID: "project", TargetID: target, Type: "maintenance", IdempotencyKey: id,
		PlanHash: "maintenance/observe", StepName: "execute", Capability: capability, TargetNodeID: "node", Payload: []byte(`{"kind":"observe"}`),
	}); err != nil {
		t.Fatal(err)
	}
}

func TestObservationJobsEvidenceActivityAndPruning(t *testing.T) {
	ctx := context.Background()
	store := openOrchestrationStore(t, filepath.Join(t.TempDir(), "control.db"))
	clock := time.UnixMilli(1_800_000_000_000).UTC()
	store.now = func() time.Time { return clock }
	const observe = "provider.maintenance.observe"

	if _, _, err := store.LatestSuccessfulTaskEvidenceAt(ctx, "target-a", observe); !errors.Is(err, ErrTaskEvidenceNotFound) {
		t.Fatalf("missing evidence error = %v", err)
	}
	createCapabilityJob(t, store, "observe-a-1", "target-a", observe)
	if active, err := store.HasActiveCapabilityJob(ctx, "target-a", observe); err != nil || !active {
		t.Fatalf("queued job active = %v, err = %v", active, err)
	}
	if active, _ := store.HasActiveCapabilityJob(ctx, "target-b", observe); active {
		t.Fatal("another target's job was reported active")
	}
	if _, err := store.ReconcileTaskResult(ctx, "observe-a-1/execute", true, []byte(`{"n":1}`), ""); err != nil {
		t.Fatal(err)
	}
	if active, _ := store.HasActiveCapabilityJob(ctx, "target-a", observe); active {
		t.Fatal("finished job was reported active")
	}
	clock = clock.Add(time.Hour)
	createCapabilityJob(t, store, "observe-a-2", "target-a", observe)
	if _, err := store.ReconcileTaskResult(ctx, "observe-a-2/execute", true, []byte(`{"n":2}`), ""); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(time.Hour)
	createCapabilityJob(t, store, "observe-a-3", "target-a", observe)
	if _, err := store.ReconcileTaskResult(ctx, "observe-a-3/execute", false, []byte(`{}`), "failed"); err != nil {
		t.Fatal(err)
	}
	createCapabilityJob(t, store, "observe-b-1", "target-b", observe)
	if _, err := store.ReconcileTaskResult(ctx, "observe-b-1/execute", true, []byte(`{"n":"b"}`), ""); err != nil {
		t.Fatal(err)
	}
	createCapabilityJob(t, store, "backup-a-1", "target-a", "provider.backup.full")
	if _, err := store.ReconcileTaskResult(ctx, "backup-a-1/execute", true, []byte(`{}`), ""); err != nil {
		t.Fatal(err)
	}

	evidence, receivedAt, err := store.LatestSuccessfulTaskEvidenceAt(ctx, "target-a", observe)
	if err != nil || string(evidence) != `{"n":2}` || !receivedAt.Equal(clock.Add(-time.Hour)) {
		t.Fatalf("latest evidence = %s at %s, err = %v", evidence, receivedAt, err)
	}

	clock = clock.Add(time.Hour)
	pruned, err := store.PruneCapabilityJobs(ctx, observe, clock, 100)
	if err != nil || pruned != 2 {
		t.Fatalf("pruned = %d, err = %v; want observe-a-1 and observe-a-3", pruned, err)
	}
	for _, kept := range []string{"observe-a-2", "observe-b-1", "backup-a-1"} {
		if _, err := store.GetJob(ctx, kept); err != nil {
			t.Fatalf("%s was not kept: %v", kept, err)
		}
	}
	for _, removed := range []string{"observe-a-1", "observe-a-3"} {
		if _, err := store.GetJob(ctx, removed); err == nil {
			t.Fatalf("%s was not pruned", removed)
		}
	}
	if pruned, err := store.PruneCapabilityJobs(ctx, observe, clock, 100); err != nil || pruned != 0 {
		t.Fatalf("second prune = %d, err = %v", pruned, err)
	}
}

func TestEnsureRepositoryRejectsAChangedIdentity(t *testing.T) {
	ctx := context.Background()
	store := openOrchestrationStore(t, filepath.Join(t.TempDir(), "control.db"))
	repository := RepositoryRecord{ID: "repo-a", Fingerprint: "s3:bucket-a", Type: "s3", Endpoint: "backup-repository", EncryptedCredentials: []byte{0}, KeyID: "agent-held"}
	for range 2 {
		if err := store.EnsureRepository(ctx, repository); err != nil {
			t.Fatal(err)
		}
	}
	repository.Fingerprint = "s3:bucket-b"
	if err := store.EnsureRepository(ctx, repository); err == nil {
		t.Fatal("a repository with a different fingerprint was accepted")
	}
}
