package singleprimary

import (
	"context"
	"errors"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

type QuarantineStore interface {
	RegisterQuarantine(context.Context, controlstore.Quarantine) error
	GetQuarantine(context.Context, string) (controlstore.Quarantine, error)
}

type ControlStoreWindows struct{ Store QuarantineStore }

func (s ControlStoreWindows) PutWindow(ctx context.Context, window Window) error {
	if s.Store == nil {
		return errors.New("quarantine control store is required")
	}
	return s.Store.RegisterQuarantine(ctx, controlstore.Quarantine{
		ID: window.ID, PlanID: window.PlanID, ResourceType: "pgdata", ResourceRef: window.QuarantineRef, RollbackUntil: window.RollbackUntil,
	})
}

func (s ControlStoreWindows) GetWindow(ctx context.Context, planID string) (Window, error) {
	if s.Store == nil {
		return Window{}, errors.New("quarantine control store is required")
	}
	item, err := s.Store.GetQuarantine(ctx, planID+"/pgdata")
	if err != nil {
		return Window{}, err
	}
	return Window{ID: item.ID, PlanID: item.PlanID, QuarantineRef: item.ResourceRef, RollbackUntil: item.RollbackUntil}, nil
}
