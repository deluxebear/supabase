package controlstore

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/pitr"
)

func TestPITRStateStorePersistsWorkflowPhaseAcrossReopen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state.db")
	identity := contracts.RecoveryDomain{SystemIdentifier: "agent", DataDomain: "pitr"}
	store, err := OpenSQLite(ctx, path, identity)
	if err != nil {
		t.Fatal(err)
	}
	adapter := PITRStateStore{Store: store}
	want := pitr.State{TargetID: "db", Generation: 7, Phase: pitr.PhaseChecked}
	if err := adapter.Save(ctx, want); err != nil {
		t.Fatal(err)
	}
	_ = store.Close()
	store, err = OpenSQLite(ctx, path, identity)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	got, err := (PITRStateStore{Store: store}).Load(ctx, "db")
	if err != nil || got != want {
		t.Fatalf("got %#v, err %v", got, err)
	}
}
