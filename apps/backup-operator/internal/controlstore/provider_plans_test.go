package controlstore

import (
	"context"
	"testing"
)

func TestProviderRestorePlanPersistsTypedRollbackInput(t *testing.T) {
	store := openOrchestrationStore(t, t.TempDir()+"/control.db")
	type typedPlan struct {
		ID       string            `json:"id"`
		Selector map[string]string `json:"selector"`
	}
	want := typedPlan{ID: "plan", Selector: map[string]string{"app": "replacement"}}
	if err := store.SaveProviderRestorePlan(context.Background(), "plan", "provider", want); err != nil {
		t.Fatal(err)
	}
	var got typedPlan
	if err := store.LoadProviderRestorePlan(context.Background(), "plan", "provider", &got); err != nil {
		t.Fatal(err)
	}
	if got.ID != want.ID || got.Selector["app"] != "replacement" {
		t.Fatalf("typed provider plan was not preserved: %+v", got)
	}
}
