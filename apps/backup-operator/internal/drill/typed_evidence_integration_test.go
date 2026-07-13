package drill_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	agentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/v1"
	"github.com/supabase/supabase/apps/backup-operator/internal/agent"
	"github.com/supabase/supabase/apps/backup-operator/internal/app"
	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/drill"
	"github.com/supabase/supabase/apps/backup-operator/internal/recoverability"
)

type typedHandler struct{ evidence []byte }

func (h typedHandler) Execute(context.Context, controlstore.OutboxTask) error { return nil }
func (h typedHandler) ExecuteWithEvidence(context.Context, controlstore.OutboxTask) ([]byte, error) {
	return h.evidence, nil
}

type rawObservation struct{ value recoverability.Observation }

func (s rawObservation) ObserveRecoverability(context.Context, string) (recoverability.Observation, error) {
	return s.value, nil
}

func TestTypedDrillEvidenceFlowsFromTaskRouterToDurableProjection(t *testing.T) {
	ctx := context.Background()
	store, err := controlstore.OpenSQLite(ctx, filepath.Join(t.TempDir(), "control.db"), contracts.RecoveryDomain{SystemIdentifier: "control", DataDomain: "control"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Date(2026, 7, 13, 2, 0, 0, 0, time.UTC)
	repo := recoverability.RepositoryIdentity{Fingerprint: "repo-1", Revision: "rev-7"}
	observation := recoverability.Observation{Repository: repo, Backup: recoverability.BackupObservation{
		Label: "backup-1", StartedAt: now.Add(-time.Hour), CompletedAt: now.Add(-30 * time.Minute), ArchiveStart: "000000010000000000000001", ArchiveStop: "000000010000000000000001", DatabaseSystemID: 42, DatabaseHistoryID: 7, RepositoryIdentity: repo,
	}, Archive: recoverability.ArchiveObservation{Segments: []recoverability.ArchiveSegment{{Name: "000000010000000000000001", RecoverableThrough: now}}, CurrentTimeline: 1, RepositoryIdentity: repo}}
	record := recoverability.DrillRecord{ID: "drill-1", TargetTime: now.Add(-5 * time.Minute), CompletedAt: now, Passed: true, EvidenceDigest: "sha256:typed", Lineage: recoverability.DrillLineage{BackupLabel: "backup-1", DatabaseSystemID: 42, DatabaseHistoryID: 7, RepositoryIdentity: repo}}
	typed, err := json.Marshal(drill.Result{ClusterID: "cluster-1", Record: record})
	if err != nil {
		t.Fatal(err)
	}
	capability := app.CapabilitySinglePrimary + ".maintenance.restore-drill"
	job, _, err := store.CreateJob(ctx, controlstore.CreateJobInput{ID: "job-drill", ProjectID: "project-1", TargetID: "cluster-1", Type: "maintenance", IdempotencyKey: "drill/1", PlanHash: "sha256:plan", StepName: "restore-drill", Capability: capability, TargetNodeID: "node-1", Payload: []byte(`{"kind":"restore-drill"}`)})
	if err != nil {
		t.Fatal(err)
	}
	router := app.NewTargetTaskRouter()
	if err := router.Register("project-1", "cluster-1", capability, typedHandler{evidence: typed}); err != nil {
		t.Fatal(err)
	}
	handler := agent.TaskRouterHandler{ProjectID: "project-1", TargetID: "cluster-1", Router: router}
	evidence, err := handler.ExecuteTask(ctx, &agentv1.Task{TaskId: job.ID + "/restore-drill", OperationId: job.ID, ClusterId: "cluster-1", NodeId: "node-1", Capability: capability, IdempotencyKey: "drill/1", ExpiresAtUnixMilliseconds: time.Now().Add(time.Minute).UnixMilli()}, nil)
	if err != nil || string(evidence) != string(typed) {
		t.Fatalf("Agent evidence=%s err=%v", evidence, err)
	}
	if changed, err := store.ReconcileTaskResult(ctx, job.ID+"/restore-drill", true, evidence, ""); err != nil || !changed {
		t.Fatalf("reconcile changed=%v err=%v", changed, err)
	}
	projection := drill.Projection{Observations: rawObservation{observation}, Results: drill.TaskResultStore{Source: store, Capability: capability}}
	window, persisted, err := projection.ObserveRecoverability(ctx, "cluster-1")
	if err != nil || persisted == nil || persisted.ID != "drill-1" || window.Confidence != recoverability.DrillVerified {
		t.Fatalf("window=%#v persisted=%#v err=%v", window, persisted, err)
	}
}
