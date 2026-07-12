package writefence

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

func TestProviderEngageVerifyAndRelease(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	target := contracts.TargetRef{ProjectID: "p", TargetID: "db"}
	dataPlane, poolers, direct := &fakeGate{}, &fakeGate{}, &fakeGate{}
	database := &fakeDatabase{}
	topology := &fakeTopology{snapshot: topologySnapshot(now)}
	provider := &Provider{ProviderID: "supabase", DataPlane: dataPlane, Poolers: poolers, DirectLogins: direct, Database: database, Topology: topology, TTL: time.Minute, Now: func() time.Time { return now }}
	handle, err := provider.Engage(context.Background(), target, topology.snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if !dataPlane.blocked || !poolers.blocked || !direct.blocked || !database.drained || !database.resolved {
		t.Fatal("fence did not close every write path")
	}
	if _, err := provider.Verify(context.Background(), handle); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Release(context.Background(), handle); err != nil {
		t.Fatal(err)
	}
	if dataPlane.blocked || poolers.blocked || direct.blocked {
		t.Fatal("release left a traffic gate blocked")
	}
}

func TestProviderRollsBackPartialFenceFailure(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	dataPlane, poolers := &fakeGate{}, &fakeGate{blockErr: errors.New("pooler unavailable")}
	provider := &Provider{
		ProviderID: "supabase", DataPlane: dataPlane, Poolers: poolers, DirectLogins: &fakeGate{},
		Database: &fakeDatabase{}, Topology: &fakeTopology{snapshot: topologySnapshot(now)}, TTL: time.Minute, Now: func() time.Time { return now },
	}
	if _, err := provider.Engage(context.Background(), contracts.TargetRef{ProjectID: "p", TargetID: "db"}, topologySnapshot(now)); err == nil {
		t.Fatal("expected engage failure")
	}
	if dataPlane.blocked {
		t.Fatal("partial fence was not rolled back")
	}
}

func TestProviderFailsVerificationWithWriterOrAlternatePrimary(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	snapshot := topologySnapshot(now)
	provider := &Provider{
		ProviderID: "supabase", DataPlane: &fakeGate{}, Poolers: &fakeGate{}, DirectLogins: &fakeGate{},
		Database: &fakeDatabase{writers: 1}, Topology: &fakeTopology{snapshot: snapshot}, TTL: time.Minute, Now: func() time.Time { return now },
	}
	handle, err := provider.Engage(context.Background(), contracts.TargetRef{ProjectID: "p", TargetID: "db"}, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Verify(context.Background(), handle); !errors.Is(err, contracts.ErrFenceIncomplete) {
		t.Fatalf("expected incomplete fence, got %v", err)
	}
}

type fakeGate struct {
	blocked  bool
	blockErr error
}

func (g *fakeGate) Block(context.Context, contracts.TargetRef) error {
	if g.blockErr != nil {
		return g.blockErr
	}
	g.blocked = true
	return nil
}
func (g *fakeGate) Blocked(context.Context, contracts.TargetRef) (bool, error) { return g.blocked, nil }
func (g *fakeGate) Unblock(context.Context, contracts.TargetRef) error {
	g.blocked = false
	return nil
}

type fakeDatabase struct {
	drained, resolved bool
	writers, prepared int
}

func (d *fakeDatabase) DrainWriters(context.Context) error { d.drained = true; return nil }
func (d *fakeDatabase) ResolvePreparedTransactions(context.Context) error {
	d.resolved = true
	return nil
}
func (d *fakeDatabase) ActiveWriters(context.Context) (int, error)        { return d.writers, nil }
func (d *fakeDatabase) PreparedTransactions(context.Context) (int, error) { return d.prepared, nil }
func (d *fakeDatabase) Healthy(context.Context) error                     { return nil }

type fakeTopology struct{ snapshot contracts.TopologySnapshot }

func (t *fakeTopology) ID() string { return "static" }
func (t *fakeTopology) Observe(context.Context, contracts.TargetRef) (contracts.TopologySnapshot, error) {
	return t.snapshot, nil
}
func (t *fakeTopology) RebuildStandbys(context.Context, contracts.TargetRef, contracts.TopologySnapshot) (contracts.Evidence, error) {
	return contracts.Evidence{}, nil
}

func topologySnapshot(now time.Time) contracts.TopologySnapshot {
	return contracts.TopologySnapshot{
		Kind:     contracts.TopologyStaticPrimary,
		Nodes:    []contracts.NodeObservation{{NodeID: "db", Role: contracts.RolePrimary, Reachable: true, SystemIdentifier: "sys"}},
		Evidence: contracts.Evidence{ProviderID: "static", ObservationID: "obs", ObservedAt: now, ValidUntil: now.Add(time.Minute)},
	}
}
