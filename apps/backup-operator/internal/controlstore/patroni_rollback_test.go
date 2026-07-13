package controlstore

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/patroni"
)

func TestSQLitePatroniRollbackStatePersistsAndTransitionsAtomically(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "control.db"), contracts.RecoveryDomain{SystemIdentifier: "control", DataDomain: "operator-state"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	now := time.Unix(1_700_000_000, 0).UTC()
	state := patroni.RollbackState{
		PlanID: "plan", Leader: "node1", LeaderTimeline: 7,
		DCSConfig: patroni.Config{SynchronousMode: true, SynchronousModeStrict: true},
		Nodes:     []patroni.NodeRollbackState{{NodeID: "node1", QuarantineRef: "quarantine-1", SystemIdentifier: "sys", Timeline: 7, DataDirectoryDigest: "digest", Primary: true}},
		Fence:     contracts.FenceHandle{ID: "fence", Target: contracts.TargetRef{ProjectID: "p", TargetID: "db"}, Expires: now.Add(time.Hour)},
		Phase:     patroni.RollbackPrepared, RollbackUntil: now.Add(30 * time.Minute),
	}
	adapter := PatroniRollbackStore{Store: store}
	if err := adapter.EnsurePatroniRollback(ctx, state); err != nil {
		t.Fatal(err)
	}
	if err := adapter.TransitionPatroniRollback(ctx, state.PlanID, patroni.RollbackPrepared, patroni.RollbackReady); err != nil {
		t.Fatal(err)
	}
	loaded, err := adapter.LoadPatroniRollback(ctx, state.PlanID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Phase != patroni.RollbackReady || loaded.Nodes[0].QuarantineRef != "quarantine-1" || !loaded.RollbackUntil.Equal(state.RollbackUntil) {
		t.Fatalf("rollback baseline did not round-trip: %+v", loaded)
	}
	if err := adapter.TransitionPatroniRollback(ctx, state.PlanID, patroni.RollbackPrepared, patroni.RollbackManual); err == nil {
		t.Fatal("stale phase transition must fail")
	}
}
