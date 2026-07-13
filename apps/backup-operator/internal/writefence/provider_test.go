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
	dataPlane, poolers, services, direct := &fakeGate{}, &fakeGate{}, &fakeGate{}, &fakeGate{}
	database := &fakeDatabase{}
	topology := &fakeTopology{snapshot: topologySnapshot(now)}
	provider := &Provider{ProviderID: "supabase", Revision: "rev", Target: target, EntryPoints: testEntryPoints(dataPlane, poolers, services, direct), Database: database, Topology: topology, State: &memoryState{}, TTL: time.Minute, Now: func() time.Time { return now }}
	handle, err := provider.Engage(context.Background(), target, topology.snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if !dataPlane.blocked || !poolers.blocked || !services.blocked || !direct.blocked || !database.drained || !database.resolved {
		t.Fatal("fence did not close every write path")
	}
	if _, err := provider.Verify(context.Background(), handle); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Release(context.Background(), handle); err != nil {
		t.Fatal(err)
	}
	if dataPlane.blocked || poolers.blocked || services.blocked || direct.blocked {
		t.Fatal("release left a traffic gate blocked")
	}
}

func TestProviderRollsBackPartialFenceFailure(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	dataPlane, poolers := &fakeGate{}, &fakeGate{blockErr: errors.New("pooler unavailable")}
	provider := &Provider{
		ProviderID: "supabase", Revision: "rev", Target: contracts.TargetRef{ProjectID: "p", TargetID: "db"}, EntryPoints: testEntryPoints(dataPlane, poolers, &fakeGate{}, &fakeGate{}),
		Database: &fakeDatabase{}, Topology: &fakeTopology{snapshot: topologySnapshot(now)}, State: &memoryState{}, TTL: time.Minute, Now: func() time.Time { return now },
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
		ProviderID: "supabase", Revision: "rev", Target: contracts.TargetRef{ProjectID: "p", TargetID: "db"}, EntryPoints: testEntryPoints(&fakeGate{}, &fakeGate{}, &fakeGate{}, &fakeGate{}),
		Database: &fakeDatabase{writers: 1}, Topology: &fakeTopology{snapshot: snapshot}, State: &memoryState{}, TTL: time.Minute, Now: func() time.Time { return now },
	}
	handle, err := provider.Engage(context.Background(), contracts.TargetRef{ProjectID: "p", TargetID: "db"}, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Verify(context.Background(), handle); !errors.Is(err, contracts.ErrFenceIncomplete) {
		t.Fatalf("expected incomplete fence, got %v", err)
	}
}

func TestProviderRequiresEveryTypedEntryPoint(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	provider := &Provider{
		ProviderID: "supabase", Revision: "rev", Target: contracts.TargetRef{ProjectID: "p", TargetID: "db"}, EntryPoints: testEntryPoints(&fakeGate{}, &fakeGate{}, &fakeGate{}, &fakeGate{}),
		Database: &fakeDatabase{}, Topology: &fakeTopology{snapshot: topologySnapshot(now)}, State: &memoryState{}, TTL: time.Minute, Now: func() time.Time { return now },
	}
	delete(provider.EntryPoints, EntryStorage)
	if _, err := provider.Engage(context.Background(), contracts.TargetRef{ProjectID: "p", TargetID: "db"}, topologySnapshot(now)); err == nil {
		t.Fatal("missing services entry point was accepted")
	}
}

func TestProviderFailsClosedForPreparedTransactionsAndAlternatePrimary(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	tests := []struct {
		name     string
		database *fakeDatabase
		snapshot contracts.TopologySnapshot
	}{
		{name: "prepared transaction", database: &fakeDatabase{prepared: 1}, snapshot: topologySnapshot(now)},
		{name: "alternate primary", database: &fakeDatabase{}, snapshot: topologyWithAlternatePrimary(now)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			provider := completeProvider(now, test.database, test.snapshot)
			handle, err := provider.Engage(context.Background(), contracts.TargetRef{ProjectID: "p", TargetID: "db"}, topologySnapshot(now))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := provider.Verify(context.Background(), handle); !errors.Is(err, contracts.ErrFenceIncomplete) {
				t.Fatalf("expected incomplete fence, got %v", err)
			}
		})
	}
}

func TestReleaseFailureReblocksAlreadyReleasedTargets(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	dataPlane, pooler, services, direct := &fakeGate{}, &fakeGate{unblockErr: errors.New("pooler API down")}, &fakeGate{}, &fakeGate{}
	provider := &Provider{ProviderID: "supabase", Revision: "rev", Target: contracts.TargetRef{ProjectID: "p", TargetID: "db"}, EntryPoints: testEntryPoints(dataPlane, pooler, services, direct), Database: &fakeDatabase{}, Topology: &fakeTopology{snapshot: topologySnapshot(now)}, State: &memoryState{}, TTL: time.Minute, Now: func() time.Time { return now }}
	handle, err := provider.Engage(context.Background(), contracts.TargetRef{ProjectID: "p", TargetID: "db"}, topologySnapshot(now))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Verify(context.Background(), handle); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Release(context.Background(), handle); err == nil {
		t.Fatal("expected release failure")
	}
	if !dataPlane.blocked || !pooler.blocked || !services.blocked || !direct.blocked {
		t.Fatalf("release failure opened a write path: data=%v pooler=%v services=%v direct=%v", dataPlane.blocked, pooler.blocked, services.blocked, direct.blocked)
	}
	pooler.unblockErr = nil
	if _, err := provider.Release(context.Background(), handle); err != nil {
		t.Fatalf("release retry: %v", err)
	}
}

func TestRefreshRequiresVerifiedFenceAndRotatesExpiry(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	current := now
	provider := completeProvider(now, &fakeDatabase{}, topologySnapshot(now))
	provider.Now = func() time.Time { return current }
	handle, err := provider.Engage(context.Background(), contracts.TargetRef{ProjectID: "p", TargetID: "db"}, topologySnapshot(now))
	if err != nil {
		t.Fatal(err)
	}
	current = now.Add(30 * time.Second)
	refreshed, err := provider.Refresh(context.Background(), handle)
	if err != nil {
		t.Fatal(err)
	}
	if !refreshed.Expires.Equal(current.Add(time.Minute)) {
		t.Fatalf("expiry was not refreshed: %v", refreshed.Expires)
	}
	if _, err := provider.Verify(context.Background(), handle); err == nil {
		t.Fatal("stale handle remained usable after refresh")
	}
	if _, err := provider.Verify(context.Background(), refreshed); err != nil {
		t.Fatal(err)
	}
}

func TestResumeRefreshesTheOriginalDurableFence(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	current := now
	provider := completeProvider(now, &fakeDatabase{}, topologySnapshot(now))
	provider.Now = func() time.Time { return current }
	handle, err := provider.Engage(context.Background(), provider.Target, topologySnapshot(now))
	if err != nil {
		t.Fatal(err)
	}
	current = now.Add(15 * time.Second)
	resumed, err := provider.Resume(context.Background(), handle.ID, handle.Target)
	if err != nil {
		t.Fatal(err)
	}
	if resumed.ID != handle.ID || !resumed.Expires.Equal(current.Add(time.Minute)) {
		t.Fatalf("resumed=%+v original=%+v", resumed, handle)
	}
	if _, err := provider.Resume(context.Background(), "different", handle.Target); err == nil {
		t.Fatal("unknown fence handle was resumed")
	}
}

type fakeGate struct {
	blocked    bool
	blockErr   error
	unblockErr error
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
	if g.unblockErr != nil {
		return g.unblockErr
	}
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

func topologyWithAlternatePrimary(now time.Time) contracts.TopologySnapshot {
	snapshot := topologySnapshot(now)
	snapshot.Nodes = append(snapshot.Nodes, contracts.NodeObservation{NodeID: "db-2", Role: contracts.RolePrimary, Reachable: true, SystemIdentifier: "sys"})
	return snapshot
}

func completeProvider(now time.Time, database *fakeDatabase, snapshot contracts.TopologySnapshot) *Provider {
	return &Provider{ProviderID: "supabase", Revision: "rev", Target: contracts.TargetRef{ProjectID: "p", TargetID: "db"}, EntryPoints: testEntryPoints(&fakeGate{}, &fakeGate{}, &fakeGate{}, &fakeGate{}), Database: database, Topology: &fakeTopology{snapshot: snapshot}, State: &memoryState{}, TTL: time.Minute, Now: func() time.Time { return now }}
}

func testEntryPoints(dataPlane, pooler, services, direct Gate) map[EntryPoint]Gate {
	return map[EntryPoint]Gate{EntryKongDataPlane: dataPlane, EntrySupavisor: pooler, EntryAuth: services, EntryStorage: services, EntryRealtime: services, EntryBackground: services, EntryDirectPG: direct}
}

type memoryState struct {
	handles map[string]trackedFence
	audit   []AuditEvent
}

func (s *memoryState) Load(context.Context) ([]trackedFence, error) {
	var result []trackedFence
	for _, item := range s.handles {
		result = append(result, item)
	}
	return result, nil
}
func (s *memoryState) Save(_ context.Context, item trackedFence) error {
	if s.handles == nil {
		s.handles = map[string]trackedFence{}
	}
	s.handles[item.handle.ID] = item
	return nil
}
func (s *memoryState) Delete(_ context.Context, id string) error { delete(s.handles, id); return nil }
func (s *memoryState) AppendAudit(_ context.Context, event AuditEvent) error {
	s.audit = append(s.audit, event)
	return nil
}
