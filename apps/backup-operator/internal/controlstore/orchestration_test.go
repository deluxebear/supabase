package controlstore

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

func TestConcurrentOutboxClaimIsExclusive(t *testing.T) {
	store := openOrchestrationStore(t, filepath.Join(t.TempDir(), "control.db"))
	createTestJob(t, store, "job-claim", "key-claim")
	start := make(chan struct{})
	var wg sync.WaitGroup
	counts := make(chan int, 2)
	for _, owner := range []string{"operator-a", "operator-b"} {
		wg.Add(1)
		go func(owner string) {
			defer wg.Done()
			<-start
			tasks, err := store.ClaimOutbox(context.Background(), owner, 1, time.Minute)
			if err != nil {
				t.Errorf("ClaimOutbox(%s): %v", owner, err)
				return
			}
			counts <- len(tasks)
		}(owner)
	}
	close(start)
	wg.Wait()
	close(counts)
	total := 0
	for count := range counts {
		total += count
	}
	if total != 1 {
		t.Fatalf("claimed tasks = %d, want exactly one", total)
	}
}

func TestReconcileTaskResultIsIdempotent(t *testing.T) {
	store := openOrchestrationStore(t, filepath.Join(t.TempDir(), "control.db"))
	createTestJob(t, store, "job-result", "key-result")
	changed, err := store.ReconcileTaskResult(context.Background(), "job-result/execute", true, nil, "")
	if err != nil || !changed {
		t.Fatalf("first result: changed=%v err=%v", changed, err)
	}
	changed, err = store.ReconcileTaskResult(context.Background(), "job-result/execute", true, nil, "")
	if err != nil || changed {
		t.Fatalf("duplicate result: changed=%v err=%v", changed, err)
	}
	job, err := store.GetJob(context.Background(), "job-result")
	if err != nil {
		t.Fatal(err)
	}
	if job.State != "succeeded" || len(job.Steps) != 1 || job.Steps[0].State != "succeeded" {
		t.Fatalf("unexpected reconciled job: %+v", job)
	}
	events, err := store.EventsAfter(context.Background(), job.ID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("events = %d, want queued and one result", len(events))
	}
}

func TestRollbackResultReleasesOnlySuccessfulRestoreLease(t *testing.T) {
	for _, test := range []struct {
		name      string
		succeeded bool
		wantLease bool
	}{
		{name: "successful rollback releases lease", succeeded: true, wantLease: true},
		{name: "failed rollback preserves lease", succeeded: false, wantLease: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			store := openOrchestrationStore(t, filepath.Join(t.TempDir(), "control.db"))
			store.now = func() time.Time { return time.Date(2026, 7, 14, 4, 0, 0, 0, time.UTC) }
			if _, acquired, err := store.AcquireLease(ctx, "destructive/target", "restore-original", 15*time.Minute); err != nil || !acquired {
				t.Fatalf("seed restore lease: acquired=%v err=%v", acquired, err)
			}
			job, created, err := store.CreateJob(ctx, CreateJobInput{
				ID: "restore-original-rollback", ProjectID: "project", TargetID: "target", Type: "rollback",
				IdempotencyKey: "rollback/restore-original", PlanHash: "plan", StepName: "rollback",
				Capability: "static-primary.rollback", TargetNodeID: "node", Payload: []byte(`{}`),
			})
			if err != nil || !created {
				t.Fatalf("create rollback job: job=%+v created=%v err=%v", job, created, err)
			}
			changed, err := store.ReconcileTaskResult(ctx, job.ID+"/rollback", test.succeeded, nil, "rollback_failed")
			if err != nil || !changed {
				t.Fatalf("reconcile rollback: changed=%v err=%v", changed, err)
			}
			_, acquired, err := store.AcquireLease(ctx, "destructive/target", "restore-next", 15*time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			if acquired != test.wantLease {
				t.Fatalf("next restore acquired lease=%v, want %v", acquired, test.wantLease)
			}
		})
	}
}

func TestPendingOutboxSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "control.db")
	store := openOrchestrationStore(t, path)
	createTestJob(t, store, "job-restart", "key-restart")
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := OpenSQLite(context.Background(), path, contracts.RecoveryDomain{SystemIdentifier: "control", DataDomain: "operator-state"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	tasks, err := store.ClaimOutbox(context.Background(), "restarted-operator", 10, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].TaskID != "job-restart/execute" {
		t.Fatalf("unexpected recovered tasks: %+v", tasks)
	}
}

func openOrchestrationStore(t *testing.T, path string) *Store {
	t.Helper()
	store, err := OpenSQLite(context.Background(), path, contracts.RecoveryDomain{SystemIdentifier: "control", DataDomain: "operator-state"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func createTestJob(t *testing.T, store *Store, id, key string) JobRecord {
	t.Helper()
	job, created, err := store.CreateJob(context.Background(), CreateJobInput{
		ID: id, ProjectID: "project", TargetID: "target", Type: "backup", IdempotencyKey: key,
		PlanHash: "plan", StepName: "execute", Capability: "pgbackrest", TargetNodeID: "node", Payload: []byte(`{"type":"full"}`),
	})
	if err != nil || !created {
		t.Fatalf("CreateJob: created=%v err=%v", created, err)
	}
	return job
}
