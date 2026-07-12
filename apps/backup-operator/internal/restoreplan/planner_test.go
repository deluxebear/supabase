package restoreplan

import (
	"errors"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

func TestBuildSelectsLatestBackupBeforeTargetAndHashesSafetyInputs(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	target := now.Add(-time.Hour)
	coverage := target.Add(time.Minute)
	drill := now.Add(-30 * time.Minute)
	topology := safeTopology(now)
	request := Request{
		PlanID: "plan-1", JobID: "job-1", Target: contracts.TargetRef{ProjectID: "p", TargetID: "db"}, RestoreTarget: target,
		Candidates: []BackupCandidate{
			{ID: "too-new", StoppedAt: target.Add(time.Minute)},
			{ID: "selected", StoppedAt: target.Add(-time.Minute), RecoverableUntil: &coverage, LastDrillAt: &drill, Identity: backupIdentity()},
			{ID: "older", StoppedAt: target.Add(-time.Hour), RecoverableUntil: &coverage, Identity: backupIdentity()},
		},
		Topology: topology, FenceProvider: "supabase-fence", BackupProvider: "pgbackrest", RepositoryRevision: "rev-1",
		Capacity: CapacityImpact{RequiredBytes: 10, AvailableBytes: 20, Destination: "/data"}, TTL: 10 * time.Minute, Now: now,
	}
	plan, err := Build(request)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Candidate.ID != "selected" || plan.Recovery != EvidenceDrillVerified || len(plan.Hash) != 64 {
		t.Fatalf("unexpected plan: %#v", plan)
	}
	if err := ValidateUnchanged(plan, plan.SafetyInputs, now); err != nil {
		t.Fatal(err)
	}
	changed := plan.SafetyInputs
	changed.RepositoryRevision = "rev-2"
	if err := ValidateUnchanged(plan, changed, now); !errors.Is(err, ErrStaleSafetyInputs) {
		t.Fatalf("expected stale inputs, got %v", err)
	}
}

func TestBuildFailsClosedOnUnknownCoverageOrCapacity(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	target := now.Add(-time.Hour)
	request := Request{
		PlanID: "plan", JobID: "job", Target: contracts.TargetRef{ProjectID: "p", TargetID: "db"}, RestoreTarget: target,
		Candidates: []BackupCandidate{{ID: "backup", StoppedAt: target.Add(-time.Minute), Identity: backupIdentity()}},
		Topology:   safeTopology(now), FenceProvider: "fence", BackupProvider: "pgbackrest", RepositoryRevision: "rev",
		Capacity: CapacityImpact{RequiredBytes: 10, AvailableBytes: 20, Destination: "/data"}, TTL: time.Minute, Now: now,
	}
	if _, err := Build(request); !errors.Is(err, ErrUnknownRecovery) {
		t.Fatalf("expected unknown recovery, got %v", err)
	}
	coverage := target
	request.Candidates[0].RecoverableUntil = &coverage
	request.Capacity.AvailableBytes = 9
	if _, err := Build(request); err == nil {
		t.Fatal("expected insufficient capacity")
	}
}

func TestValidateAAL2RequiresFreshAssertion(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	if err := ValidateAAL2(AAL2Assertion{Subject: "user", Authenticated: now.Add(-time.Minute)}, now, 5*time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAAL2(AAL2Assertion{Subject: "user", Authenticated: now.Add(-time.Hour)}, now, 5*time.Minute); !errors.Is(err, ErrAAL2Required) {
		t.Fatalf("expected AAL2 rejection, got %v", err)
	}
}

func safeTopology(now time.Time) contracts.TopologySnapshot {
	return contracts.TopologySnapshot{
		Kind:     contracts.TopologyStaticPrimary,
		Nodes:    []contracts.NodeObservation{{NodeID: "db", Role: contracts.RolePrimary, Reachable: true, SystemIdentifier: "sys"}},
		Evidence: contracts.Evidence{ProviderID: "static", ObservationID: "obs", ObservedAt: now, ValidUntil: now.Add(time.Minute)},
	}
}

func backupIdentity() contracts.BackupIdentity {
	return contracts.BackupIdentity{ProviderID: "pgbackrest", RepositoryID: "repo", Stanza: "supabase", SystemIdentifier: "sys", DatabaseHistory: "history"}
}
