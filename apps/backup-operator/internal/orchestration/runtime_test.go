package orchestration

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

type resultStoreFake struct {
	reconciled int
	manifests  []controlstore.BackupManifestRecord
}

func (s *resultStoreFake) ReconcileTaskResult(context.Context, string, bool, []byte, string) (bool, error) {
	s.reconciled++
	return true, nil
}

func (s *resultStoreFake) RecordBackupManifest(_ context.Context, manifest controlstore.BackupManifestRecord) error {
	s.manifests = append(s.manifests, manifest)
	return nil
}

type dispatcherStore struct {
	tasks    []controlstore.OutboxTask
	marked   int
	released int
}

func (s *dispatcherStore) ClaimOutbox(context.Context, string, int, time.Duration) ([]controlstore.OutboxTask, error) {
	return s.tasks, nil
}
func (s *dispatcherStore) MarkOutboxDelivered(context.Context, string, string) (bool, error) {
	s.marked++
	return true, nil
}
func (s *dispatcherStore) ReleaseOutbox(context.Context, string, string) error {
	s.released++
	return nil
}

type senderFunc func(context.Context, controlstore.OutboxTask) error

func (f senderFunc) Send(ctx context.Context, task controlstore.OutboxTask) error {
	return f(ctx, task)
}

func TestDispatcherMarksSuccessAndReleasesFailure(t *testing.T) {
	store := &dispatcherStore{tasks: []controlstore.OutboxTask{{TaskID: "ok"}, {TaskID: "retry"}}}
	dispatcher := Dispatcher{Store: store, OwnerID: "owner", BatchSize: 2, ClaimTTL: time.Minute, Sender: senderFunc(func(_ context.Context, task controlstore.OutboxTask) error {
		if task.TaskID == "retry" {
			return errors.New("agent unavailable")
		}
		return nil
	})}
	if err := dispatcher.DispatchOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if store.marked != 1 || store.released != 1 {
		t.Fatalf("marked=%d released=%d", store.marked, store.released)
	}
}

func TestReconcilerPersistsSuccessfulBackupManifestBeforeCompletingJob(t *testing.T) {
	store := &resultStoreFake{}
	manifest := controlstore.BackupManifestRecord{
		ProviderJobID: "20260714-023549F",
		PolicyID:      "policy-a",
		RepositoryID:  "repo-a",
		BackupLabel:   "20260714-023549F",
		BackupType:    "full",
		CompletedAt:   time.Date(2026, 7, 14, 2, 35, 52, 0, time.UTC),
		ManifestJSON:  "{}",
	}
	evidence, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan Result, 1)
	results <- Result{TaskID: "task-a", Capability: "single-primary-pgbackrest.backup.full", Succeeded: true, Evidence: evidence}
	close(results)
	err = (&Reconciler{Store: store, Results: results}).Run(context.Background())
	if err == nil || err.Error() != "job result stream closed" {
		t.Fatalf("run error = %v", err)
	}
	if store.reconciled != 1 || len(store.manifests) != 1 || store.manifests[0].BackupLabel != manifest.BackupLabel {
		t.Fatalf("reconciled=%d manifests=%#v", store.reconciled, store.manifests)
	}
}
