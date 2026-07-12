package controlstore

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

func TestPostgresTransactionalOutboxIntegration(t *testing.T) {
	dsn := os.Getenv("CONTROLSTORE_POSTGRES_TEST_DSN")
	if dsn == "" {
		t.Skip("CONTROLSTORE_POSTGRES_TEST_DSN is not set")
	}
	ctx := context.Background()
	store, err := OpenPostgres(ctx, dsn, contracts.RecoveryDomain{SystemIdentifier: "control-postgres", DataDomain: "control-postgres-volume"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	target := contracts.TargetRef{ProjectID: "integration", TargetID: "target"}
	if err := store.RegisterTarget(ctx, target, contracts.RecoveryDomain{SystemIdentifier: "managed", DataDomain: "managed-volume"}); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateOperation(ctx, contracts.OperationRecord{ID: "integration-job", Target: target, IdempotencyKey: "integration-key", PlanHash: "hash"}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := store.TransitionWithOutbox(ctx,
		contracts.StepTransition{OperationID: "integration-job", Step: "dispatch", From: "created", To: "queued", Evidence: contracts.Evidence{ProviderID: "test", ObservationID: "1", ObservedAt: now, ValidUntil: now.Add(time.Minute)}},
		contracts.TaskEnvelope{TaskID: "integration-task", OperationID: "integration-job", Capability: "inspect", TargetNodeID: "node", IdempotencyKey: "integration-dispatch"},
	); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordTaskResult(ctx, contracts.TaskResult{TaskID: "integration-task", Succeeded: true}); err != nil {
		t.Fatal(err)
	}
	jobs, events, outbox, results, err := store.Counts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if jobs != 1 || events != 1 || outbox != 1 || results != 1 {
		t.Fatalf("unexpected counts: %d %d %d %d", jobs, events, outbox, results)
	}

	// Reopening runs the migration set again and must preserve the persisted
	// identity and existing rows.
	second, err := OpenPostgres(ctx, dsn, contracts.RecoveryDomain{SystemIdentifier: "control-postgres", DataDomain: "control-postgres-volume"})
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	for index := 2; index <= 3; index++ {
		jobID := "integration-job-" + string(rune('0'+index))
		if err := store.CreateOperation(ctx, contracts.OperationRecord{ID: jobID, Target: target, IdempotencyKey: "key-" + jobID, PlanHash: "hash"}); err != nil {
			t.Fatal(err)
		}
		if err := store.TransitionWithOutbox(ctx,
			contracts.StepTransition{OperationID: jobID, Step: "dispatch", From: "created", To: "queued", Evidence: contracts.Evidence{ProviderID: "test", ObservationID: jobID, ObservedAt: now, ValidUntil: now.Add(time.Minute)}},
			contracts.TaskEnvelope{TaskID: "task-" + jobID, OperationID: jobID, Capability: "inspect", TargetNodeID: "node", IdempotencyKey: "dispatch-" + jobID},
		); err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	claimed := make(chan string, 2)
	for index, candidate := range []*Store{store, second} {
		wg.Add(1)
		go func(owner string, candidate *Store) {
			defer wg.Done()
			tasks, claimErr := candidate.ClaimOutbox(ctx, owner, 1, time.Minute)
			if claimErr != nil {
				t.Errorf("claim: %v", claimErr)
				return
			}
			if len(tasks) == 1 {
				claimed <- tasks[0].TaskID
			}
		}("dispatcher-"+string(rune('a'+index)), candidate)
	}
	wg.Wait()
	close(claimed)
	seen := map[string]bool{}
	for taskID := range claimed {
		if seen[taskID] {
			t.Fatalf("task claimed twice: %s", taskID)
		}
		seen[taskID] = true
	}
	if len(seen) != 2 {
		t.Fatalf("expected two distinct concurrent claims, got %#v", seen)
	}
}
