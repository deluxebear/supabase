package orchestration

import (
	"context"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/recoveryexec"
)

type resolutionStore struct {
	record     OrphanRecord
	resolution Resolution
	calls      int
}

func (s *resolutionStore) LoadOrphan(context.Context, string) (OrphanRecord, error) {
	return s.record, nil
}
func (s *resolutionStore) ResolveOrphan(_ context.Context, _ OrphanRecord, resolution Resolution) error {
	s.calls++
	s.resolution = resolution
	return nil
}

type resolutionInspector struct {
	status recoveryexec.PostconditionStatus
}

func (i resolutionInspector) InspectResolution(context.Context, OrphanRecord) (recoveryexec.Postcondition, error) {
	return recoveryexec.Postcondition{Status: i.status, Evidence: "host-inspection"}, nil
}

func TestOrphanRetryRequiresProofSideEffectAbsent(t *testing.T) {
	store := &resolutionStore{record: OrphanRecord{TaskID: "task", PlanID: "plan", Step: recoveryexec.StepCutOver, Class: recoveryexec.Orphan}}
	request := ResolutionRequest{TaskID: "task", Action: ResolutionRetry, OperatorID: "operator", Reason: "verified no selector change", Evidence: "inspection:1"}
	service := ResolutionService{Store: store, Inspector: resolutionInspector{status: recoveryexec.PostconditionUncertain}}
	if _, err := service.Resolve(context.Background(), request); err == nil || store.calls != 0 {
		t.Fatal("uncertain cutover was approved for automatic replay")
	}
	service.Inspector = resolutionInspector{status: recoveryexec.PostconditionAbsent}
	if _, err := service.Resolve(context.Background(), request); err != nil || store.calls != 1 {
		t.Fatalf("proven-absent retry not recorded: %v", err)
	}
}

func TestManualInterventionRecordsActorEvidenceAndUTC(t *testing.T) {
	now := time.Date(2026, 7, 13, 2, 0, 0, 0, time.UTC)
	store := &resolutionStore{record: OrphanRecord{TaskID: "task", Class: recoveryexec.Manual}}
	service := ResolutionService{Store: store, Inspector: resolutionInspector{status: recoveryexec.PostconditionUncertain}, Now: func() time.Time { return now }}
	resolution, err := service.Resolve(context.Background(), ResolutionRequest{TaskID: "task", Action: ResolutionManual, OperatorID: "oncall", Reason: "preserve both PGDATA trees", Evidence: "ticket:123"})
	if err != nil {
		t.Fatal(err)
	}
	if resolution.OperatorID != "oncall" || resolution.Evidence != "ticket:123" || resolution.ResolvedAt != now {
		t.Fatalf("manual evidence: %#v", resolution)
	}
}
