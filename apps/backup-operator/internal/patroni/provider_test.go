package patroni

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

func TestAssessmentModelsPausedDCSWatchdogAndManualOperations(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	provider := testProvider(now)
	provider.API.(*fakeAPI).config.Paused = true
	assessment, err := provider.Assess(context.Background(), contracts.TargetRef{})
	if err != nil {
		t.Fatal(err)
	}
	if len(assessment.Snapshot.Nodes) != 3 || assessment.Snapshot.Kind != contracts.TopologyPatroni {
		t.Fatalf("unexpected snapshot: %#v", assessment.Snapshot)
	}
	foundManual := false
	for _, blocker := range assessment.Blockers {
		if blocker.Code == BlockerManualOpsAvailable {
			foundManual = true
		}
	}
	if !foundManual {
		t.Fatal("paused Patroni must report that manual operations remain possible")
	}
}

func TestAssessmentExposesDualPrimaryAndDCSLeaderMismatch(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	provider := testProvider(now)
	provider.API.(*fakeAPI).cluster.Members[1].Role = "leader"
	snapshot, err := provider.Observe(context.Background(), contracts.TargetRef{})
	if err != nil {
		t.Fatal(err)
	}
	if err := snapshot.ValidateForDestructive(now); !errors.Is(err, contracts.ErrTopologyUncertain) {
		t.Fatalf("expected dual-primary rejection, got %v", err)
	}
}

func TestRebuildClusterFallsBackToFreshRebuildAndVerifiesHealth(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	provider := testProvider(now)
	rebuilder := &fakeRebuilder{reinitFailures: map[string]error{"node2": errors.New("reinit failed")}}
	before, _ := provider.Observe(context.Background(), contracts.TargetRef{})
	result, err := RebuildCluster(context.Background(), provider, contracts.TargetRef{}, before, rebuilder, 1024)
	if err != nil {
		t.Fatal(err)
	}
	if result.Manual || len(result.Nodes) != 2 || !rebuilder.fresh["node2"] || !rebuilder.archiveChecked {
		t.Fatalf("unexpected rebuild: %#v %#v", result, rebuilder)
	}
}

func TestRebuildClusterReturnsManualPartialState(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	provider := testProvider(now)
	rebuilder := &fakeRebuilder{
		reinitFailures: map[string]error{"node2": errors.New("failed")},
		freshFailures:  map[string]error{"node2": errors.New("disk failed")},
	}
	before, _ := provider.Observe(context.Background(), contracts.TargetRef{})
	result, err := RebuildCluster(context.Background(), provider, contracts.TargetRef{}, before, rebuilder, 1024)
	if err == nil || !result.Manual || result.Nodes[0].State != "manual" {
		t.Fatalf("expected manual partial state: %#v %v", result, err)
	}
}

func testProvider(now time.Time) *Provider {
	api := &fakeAPI{
		cluster: Cluster{Members: []Member{
			{Name: "node1", Role: "leader", State: "running", Timeline: 3},
			{Name: "node2", Role: "replica", State: "running", Timeline: 3},
			{Name: "node3", Role: "replica", State: "running", Timeline: 3},
		}},
		config: Config{SynchronousMode: true, SynchronousModeStrict: true},
	}
	identities := map[string]NodeIdentity{}
	for _, name := range []string{"node1", "node2", "node3"} {
		identities[name] = NodeIdentity{SystemIdentifier: "sys", Reachable: true, WatchdogHealthy: true}
	}
	return &Provider{
		ProviderID: "patroni", API: api,
		DCS:   &fakeDCS{state: DCSState{Healthy: true, Leader: "node1", HistoryID: "history", Revision: "42"}},
		Nodes: fakeNodes(identities), Now: func() time.Time { return now },
	}
}

type fakeAPI struct {
	cluster Cluster
	config  Config
}

func (a *fakeAPI) Cluster(context.Context) (Cluster, error) { return a.cluster, nil }
func (a *fakeAPI) Config(context.Context) (Config, error)   { return a.config, nil }
func (a *fakeAPI) SetPaused(_ context.Context, paused bool) error {
	a.config.Paused = paused
	return nil
}

type fakeDCS struct {
	state      DCSState
	reconciled bool
}

func (d *fakeDCS) Observe(context.Context) (DCSState, error) { return d.state, nil }
func (d *fakeDCS) Reconcile(_ context.Context, leader string, _ uint64) error {
	d.state.Leader = leader
	d.state.Revision = "43"
	d.reconciled = true
	return nil
}

type fakeNodes map[string]NodeIdentity

func (n fakeNodes) Identity(_ context.Context, node string) (NodeIdentity, error) {
	return n[node], nil
}

type fakeRebuilder struct {
	reinitFailures map[string]error
	freshFailures  map[string]error
	fresh          map[string]bool
	archiveChecked bool
}

func (r *fakeRebuilder) StopCluster(context.Context, []string) error         { return nil }
func (r *fakeRebuilder) StartRecoveredPrimary(context.Context, string) error { return nil }
func (r *fakeRebuilder) Reinitialize(_ context.Context, node string) error {
	return r.reinitFailures[node]
}
func (r *fakeRebuilder) FreshRebuild(_ context.Context, node string) error {
	if r.fresh == nil {
		r.fresh = map[string]bool{}
	}
	r.fresh[node] = true
	return r.freshFailures[node]
}
func (r *fakeRebuilder) ArchiveHealthy(context.Context, string) error {
	r.archiveChecked = true
	return nil
}
