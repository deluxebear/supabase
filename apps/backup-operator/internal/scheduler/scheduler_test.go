package scheduler

import (
	"errors"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

func TestSelectStandbyNeverFallsBackToPrimary(t *testing.T) {
	policy := controlstore.BackupPolicyRecord{BackupFrom: "standby", DesignatedStandby: "standby-1", MaxStandbyLagBytes: 100}
	topology := contracts.TopologySnapshot{Nodes: []contracts.NodeObservation{
		{NodeID: "primary", Role: contracts.RolePrimary, Reachable: true},
		{NodeID: "standby-1", Role: contracts.RoleStandby, Reachable: true, LagBytes: 101},
	}}
	if _, err := SelectExecutionNode(policy, topology); !errors.Is(err, ErrStandbyLag) {
		t.Fatalf("expected lag gate, got %v", err)
	}
	topology.Nodes = topology.Nodes[:1]
	if _, err := SelectExecutionNode(policy, topology); !errors.Is(err, ErrStandbyUnavailable) {
		t.Fatalf("implicit fallback occurred: %v", err)
	}
}

func TestScheduleUsesUTC(t *testing.T) {
	after := time.Date(2026, 7, 12, 10, 30, 0, 0, time.FixedZone("local", 8*60*60))
	next, err := Next("0 * * * *", after)
	if err != nil {
		t.Fatal(err)
	}
	if next.Location() != time.UTC || next.Minute() != 0 {
		t.Fatalf("unexpected next run: %v", next)
	}
}
