package controlstore

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

func createDestructiveTestJob(t *testing.T, store *Store, id, capability string) int64 {
	t.Helper()
	_, _, err := store.CreateJob(context.Background(), CreateJobInput{
		ID: id, ProjectID: "project", TargetID: "cluster", Type: "maintenance",
		IdempotencyKey: id, PlanHash: "hash/" + id, StepName: "execute",
		Capability: capability, TargetNodeID: "node", Payload: []byte(`{}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	var token int64
	if err := store.db.QueryRow("SELECT fencing_token FROM job_steps WHERE job_id=? AND name='execute'", id).Scan(&token); err != nil {
		t.Fatal(err)
	}
	return token
}

func TestDestructiveCapabilitiesSharePersistentMonotonicAgentCounter(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "control.db")
	identity := contracts.RecoveryDomain{SystemIdentifier: "control", DataDomain: "state"}
	store, err := OpenSQLite(ctx, path, identity)
	if err != nil {
		t.Fatal(err)
	}
	capabilities := []string{
		"single-primary-pgbackrest.maintenance.restore-drill",
		"patroni-pgbackrest.restore.execute",
		"custom-postgres-kubernetes.restore.rollback",
		"cloudnativepg-cnpg-i.restore.execute",
		"single-primary-pgbackrest.pitr.enable",
		"single-primary-pgbackrest.maintenance.expire",
	}
	for index, capability := range capabilities[:3] {
		if token := createDestructiveTestJob(t, store, fmt.Sprintf("job-%d", index+1), capability); token != int64(index+1) {
			t.Fatalf("%s token=%d want=%d", capability, token, index+1)
		}
	}
	// Replaying the same durable job/idempotency key must reuse its task token
	// and must not consume a new counter value.
	if token := createDestructiveTestJob(t, store, "job-2", capabilities[1]); token != 2 {
		t.Fatalf("idempotent task token=%d want=2", token)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = OpenSQLite(ctx, path, identity)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	for index, capability := range capabilities[3:] {
		want := int64(index + 4)
		if token := createDestructiveTestJob(t, store, fmt.Sprintf("job-%d", want), capability); token != want {
			t.Fatalf("restart %s token=%d want=%d", capability, token, want)
		}
	}
}

func TestConcurrentDestructiveTasksReceiveUniqueIncreasingTokens(t *testing.T) {
	store := openOrchestrationStore(t, filepath.Join(t.TempDir(), "control.db"))
	const count = 12
	tokens := make([]int64, count)
	errs := make(chan error, count)
	var wg sync.WaitGroup
	for index := range count {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := fmt.Sprintf("concurrent-%02d", index)
			_, _, err := store.CreateJob(context.Background(), CreateJobInput{ID: id, ProjectID: "project", TargetID: "cluster", Type: "restore", IdempotencyKey: id, PlanHash: id, StepName: "execute", Capability: "patroni-pgbackrest.restore.execute", TargetNodeID: "node", Payload: []byte(`{}`)})
			if err != nil {
				errs <- err
				return
			}
			errs <- store.db.QueryRow("SELECT fencing_token FROM job_steps WHERE job_id=?", id).Scan(&tokens[index])
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	sort.Slice(tokens, func(i, j int) bool { return tokens[i] < tokens[j] })
	for index, token := range tokens {
		if token != int64(index+1) {
			t.Fatalf("tokens=%v", tokens)
		}
	}
}

func TestAdvanceRecoveryFencingTokenIsMonotonicAndIdempotent(t *testing.T) {
	store := openOrchestrationStore(t, filepath.Join(t.TempDir(), "control.db"))
	ctx := context.Background()
	target := contracts.TargetRef{ProjectID: "project", TargetID: "target"}
	if err := store.RegisterTarget(ctx, target, contracts.RecoveryDomain{SystemIdentifier: "managed", DataDomain: "pgdata"}); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateOperation(ctx, contracts.OperationRecord{ID: "job", Target: target, IdempotencyKey: "key", PlanHash: "hash"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveRestorePlan(ctx, RestorePlanRecord{ID: "plan", JobID: "job", PlanHash: "hash", SafetyInputJSON: `{}`, ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateRecoveryExecution(ctx, "plan", "fence", 7); err != nil {
		t.Fatal(err)
	}
	for _, token := range []int64{9, 9} {
		execution, err := store.AdvanceRecoveryFencingToken(ctx, "plan", token)
		if err != nil {
			t.Fatal(err)
		}
		if execution.FencingToken != 9 || execution.FenceHandleID != "fence" {
			t.Fatalf("execution=%+v", execution)
		}
	}
	if _, err := store.AdvanceRecoveryFencingToken(ctx, "plan", 8); err == nil {
		t.Fatal("stale rollback token took ownership from the current task")
	}
}
