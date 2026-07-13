package runtime

import (
	"context"
	"errors"
	"testing"
	"time"

	operatorapi "github.com/supabase/supabase/apps/backup-operator/internal/api"
	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
)

type requestSource struct{ request restoreplan.Request }

func (s requestSource) Observe(context.Context, string, time.Time) (restoreplan.Request, error) {
	return s.request, nil
}

func TestRefreshingSourceStaysFreshAcrossTTLAndInvalidatesOldPlan(t *testing.T) {
	base := time.Date(2026, 7, 13, 12, 0, 0, 0, time.UTC)
	current := base
	target := base.Add(-time.Hour)
	coverage := target.Add(time.Minute)
	refreshes := 0
	source := &RefreshingLocalSource{Refresh: func(context.Context) (operatorapi.RestoreObservationSource, error) {
		refreshes++
		evidence := contracts.Evidence{ProviderID: "trusted", ObservationID: current.Format(time.RFC3339Nano), ObservedAt: current, ValidUntil: current.Add(30 * time.Second)}
		request := restoreplan.Request{PlanID: "plan", JobID: "job", Target: contracts.TargetRef{ProjectID: "p", TargetID: "c"}, RestoreTarget: target, Candidates: []restoreplan.BackupCandidate{{ID: "backup", Label: "20260713-100000F", Identity: contracts.BackupIdentity{ProviderID: "pgbackrest", RepositoryID: "repo", Stanza: "db", SystemIdentifier: "42", DatabaseHistory: "7"}, StartedAt: target.Add(-time.Hour), StoppedAt: target.Add(-time.Minute), RecoverableUntil: &coverage}}, Topology: contracts.TopologySnapshot{Kind: contracts.TopologyStaticPrimary, Authority: "trusted", Evidence: evidence, Nodes: []contracts.NodeObservation{{NodeID: "primary", Role: contracts.RolePrimary, Reachable: true, SystemIdentifier: "42"}}}, FenceProvider: "fence", BackupProvider: "pgbackrest", RepositoryRevision: "rev", Capacity: restoreplan.CapacityImpact{RequiredBytes: 10, AvailableBytes: 20, Destination: "/restore"}, TTL: time.Minute, Now: current}
		return requestSource{request}, nil
	}}
	firstRequest, err := source.Observe(context.Background(), "c", target)
	if err != nil {
		t.Fatal(err)
	}
	first, err := restoreplan.Build(firstRequest)
	if err != nil {
		t.Fatal(err)
	}
	current = base.Add(31 * time.Second)
	secondRequest, err := source.Observe(context.Background(), "c", target)
	if err != nil {
		t.Fatal(err)
	}
	second, err := restoreplan.Build(secondRequest)
	if err != nil {
		t.Fatal(err)
	}
	if refreshes != 2 || first.Hash == second.Hash {
		t.Fatalf("refreshes=%d hashes=%s/%s", refreshes, first.Hash, second.Hash)
	}
	if err := restoreplan.ValidateUnchanged(first, second.SafetyInputs, current); !errors.Is(err, contracts.ErrEvidenceExpired) {
		t.Fatalf("old plan outlived its confirmed evidence deadline: %v", err)
	}
}
