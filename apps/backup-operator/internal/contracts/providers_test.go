package contracts

import (
	"errors"
	"testing"
	"time"
)

func validEvidence(now time.Time) Evidence {
	return Evidence{ProviderID: "test", ObservationID: "observation-1", ObservedAt: now, ValidUntil: now.Add(time.Minute)}
}

func TestFenceEvidenceFailsClosed(t *testing.T) {
	now := time.Now()
	evidence := FenceEvidence{
		Evidence:              validEvidence(now),
		DataPlaneBlocked:      true,
		PoolersBlocked:        true,
		DirectLoginBlocked:    true,
		ActiveWriters:         0,
		PreparedTransactions:  1,
		ControlChannelHealthy: true,
	}
	if err := evidence.Validate(now); !errors.Is(err, ErrFenceIncomplete) {
		t.Fatalf("expected incomplete fence, got %v", err)
	}
	evidence.PreparedTransactions = 0
	if err := evidence.Validate(now); err != nil {
		t.Fatalf("expected complete fence: %v", err)
	}
}

func TestTopologyRejectsMultiplePrimaries(t *testing.T) {
	now := time.Now()
	snapshot := TopologySnapshot{
		Kind:     TopologyPatroni,
		Evidence: validEvidence(now),
		Nodes: []NodeObservation{
			{NodeID: "a", Role: RolePrimary, Reachable: true, SystemIdentifier: "1"},
			{NodeID: "b", Role: RolePrimary, Reachable: true, SystemIdentifier: "1"},
		},
	}
	if err := snapshot.ValidateForDestructive(now); !errors.Is(err, ErrTopologyUncertain) {
		t.Fatalf("expected uncertain topology, got %v", err)
	}
}

func TestReplacementPlanRequiresNewDestination(t *testing.T) {
	now := time.Now()
	plan := RecoveryPlan{
		ID:               "plan-1",
		Mode:             RecoveryReplacementWorkload,
		Target:           TargetRef{ProjectID: "p", TargetID: "t"},
		Topology:         TopologySnapshot{Kind: TopologyKubernetesSelfOwned, Evidence: validEvidence(now), Nodes: []NodeObservation{{NodeID: "a", Role: RolePrimary, Reachable: true, SystemIdentifier: "1"}}},
		Backup:           BackupIdentity{ProviderID: "pgbackrest", RepositoryID: "repo", Stanza: "s", SystemIdentifier: "1", DatabaseHistory: "h"},
		Recovery:         RestoreTarget{Time: now.Add(-time.Hour)},
		TargetSystemID:   "1",
		Destination:      "pvc-old",
		DestinationIsNew: false,
		PlanHash:         "hash",
		ExpiresAt:        now.Add(time.Minute),
	}
	if err := plan.Validate(now); !errors.Is(err, ErrInPlaceManagedPVC) {
		t.Fatalf("expected new destination requirement, got %v", err)
	}
}
