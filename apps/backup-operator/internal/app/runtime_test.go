package app

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/orchestration"
)

func TestPeriodicWorkerContinuesAfterTransientCycleFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var attempts atomic.Int64
	worker := &periodicWorker{name: "transient-observer", interval: time.Millisecond, run: func(context.Context) error {
		if attempts.Add(1) == 1 {
			return errors.New("database temporarily fenced")
		}
		cancel()
		return nil
	}}
	if err := worker.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if attempts.Load() < 2 {
		t.Fatalf("periodic worker exited after transient failure: attempts=%d", attempts.Load())
	}
}

func TestDefaultRuntimeAllModeLifecycleUsesInProcessAgentAndStopsEveryWorker(t *testing.T) {
	ctx := context.Background()
	store, err := controlstore.OpenSQLite(ctx, filepath.Join(t.TempDir(), "control.db"), contracts.RecoveryDomain{SystemIdentifier: "control", DataDomain: "operator-state"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	_, created, err := store.CreateJob(ctx, controlstore.CreateJobInput{
		ID: "job-runtime", ProjectID: "project", TargetID: "node-a", Type: "backup",
		IdempotencyKey: "runtime-key", PlanHash: "plan", StepName: "execute",
		Capability: "backup.full", TargetNodeID: "node-a", Payload: []byte(`{"type":"full"}`),
	})
	if err != nil || !created {
		t.Fatalf("seed job: created=%v err=%v", created, err)
	}
	var observed, projected, drilled atomic.Int64
	providers := RuntimeProviders{
		Observer:   func(context.Context) error { observed.Add(1); return nil },
		Projection: func(context.Context) error { projected.Add(1); return nil },
		Cleanup:    func(context.Context, controlstore.Quarantine) error { return nil },
		// These remote transport values deliberately fail if all mode uses them.
		Sender: senderFuncForRuntime(func(context.Context, controlstore.OutboxTask) error {
			t.Fatal("all mode used remote sender")
			return nil
		}),
		Results: make(chan orchestration.Result),
		ExecuteInProcess: func(_ context.Context, task controlstore.OutboxTask) orchestration.Result {
			return orchestration.Result{TaskID: task.TaskID, Succeeded: true}
		},
		Drill: &periodicWorker{name: "isolated-restore-drill", interval: 5 * time.Millisecond, run: func(context.Context) error { drilled.Add(1); return nil }},
	}
	cfg := testConfig()
	cfg.Mode = ModeAll
	cfg.Runtime = RuntimeConfig{Enabled: true, OwnerID: "operator-a", PollInterval: 5 * time.Millisecond, LeaseTTL: 30 * time.Millisecond}
	workers, configured, err := defaultRuntimeWorkerFactory(providers)(cfg, store)
	if err != nil || !configured {
		t.Fatalf("assemble runtime: configured=%v err=%v", configured, err)
	}
	names := make([]string, 0, len(workers))
	for _, worker := range workers {
		names = append(names, worker.Name())
	}
	sort.Strings(names)
	want := []string{"cleanup", "in-process-agent-transport", "isolated-restore-drill", "job-step-reconciler", "lease", "observer", "orphan-reconciler", "outbox-dispatcher", "projection", "scheduler"}
	sort.Strings(want)
	if len(names) != len(want) {
		t.Fatalf("worker names=%v want=%v", names, want)
	}
	for index := range want {
		if names[index] != want[index] {
			t.Fatalf("worker names=%v want=%v", names, want)
		}
	}
	runCtx, cancel := context.WithCancel(context.Background())
	var group sync.WaitGroup
	errors := make(chan error, len(workers))
	for _, worker := range workers {
		group.Add(1)
		go func(worker Worker) {
			defer group.Done()
			errors <- worker.Run(runCtx)
		}(worker)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		job, getErr := store.GetJob(ctx, "job-runtime")
		if getErr == nil && job.State == "succeeded" && observed.Load() > 0 && projected.Load() > 0 && drilled.Load() > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("runtime did not converge: job=%+v err=%v observed=%d projected=%d drilled=%d", job, getErr, observed.Load(), projected.Load(), drilled.Load())
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	done := make(chan struct{})
	go func() { group.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("runtime workers did not stop")
	}
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatalf("worker shutdown: %v", err)
		}
	}
}

func TestDefaultRuntimeMissingDependencyDegradesCapabilityWithoutStartupFailure(t *testing.T) {
	store := &fakeStore{}
	cfg := testConfig()
	cfg.Mode = ModeAll
	cfg.Runtime = RuntimeConfig{Enabled: true, OwnerID: "operator-a"}
	workers, configured, err := defaultRuntimeWorkerFactory(RuntimeProviders{})(cfg, store)
	if err != nil || configured || len(workers) != 0 {
		t.Fatalf("incomplete runtime should degrade: workers=%d configured=%v err=%v", len(workers), configured, err)
	}
}

func TestInProcessTransportBoundsConcurrentBackupOperations(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var active, peak atomic.Int64
	transport := newInProcessTransport(func(_ context.Context, task controlstore.OutboxTask) orchestration.Result {
		current := active.Add(1)
		for current > peak.Load() && !peak.CompareAndSwap(peak.Load(), current) {
		}
		time.Sleep(5 * time.Millisecond)
		active.Add(-1)
		return orchestration.Result{TaskID: task.TaskID, Succeeded: true}
	}, 32, 4, nil)
	done := make(chan error, 1)
	go func() { done <- transport.Run(ctx) }()
	for index := 0; index < 20; index++ {
		if err := transport.Send(ctx, controlstore.OutboxTask{TaskID: fmt.Sprintf("task-%d", index)}); err != nil {
			t.Fatal(err)
		}
	}
	for index := 0; index < 20; index++ {
		<-transport.results
	}
	if peak.Load() != 4 {
		t.Fatalf("peak backup operation concurrency = %d", peak.Load())
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

type senderFuncForRuntime func(context.Context, controlstore.OutboxTask) error

func (f senderFuncForRuntime) Send(ctx context.Context, task controlstore.OutboxTask) error {
	return f(ctx, task)
}
