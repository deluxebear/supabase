package controlstore

import (
	"context"
	"database/sql"
	"errors"

	"github.com/supabase/supabase/apps/backup-operator/internal/pitr"
)

type PITRStateStore struct{ Store *Store }

func (s PITRStateStore) Load(ctx context.Context, targetID string) (pitr.State, error) {
	if s.Store == nil || targetID == "" {
		return pitr.State{}, errors.New("control store and PITR target are required")
	}
	query := "SELECT generation,phase FROM pitr_workflow_states WHERE target_id=?"
	if s.Store.dialect == Postgres {
		query = "SELECT generation,phase FROM pitr_workflow_states WHERE target_id=$1"
	}
	state := pitr.State{TargetID: targetID, Phase: pitr.PhaseDisabled}
	if err := s.Store.db.QueryRowContext(ctx, query, targetID).Scan(&state.Generation, &state.Phase); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return state, nil
		}
		return pitr.State{}, err
	}
	return state, nil
}

func (s PITRStateStore) Save(ctx context.Context, state pitr.State) error {
	if s.Store == nil || state.TargetID == "" || state.Generation < 1 || state.Phase == "" {
		return errors.New("complete PITR state is required")
	}
	query := `INSERT INTO pitr_workflow_states(target_id,generation,phase,updated_at_ms) VALUES(?,?,?,?)
ON CONFLICT(target_id) DO UPDATE SET generation=excluded.generation,phase=excluded.phase,updated_at_ms=excluded.updated_at_ms`
	if s.Store.dialect == Postgres {
		query = `INSERT INTO pitr_workflow_states(target_id,generation,phase,updated_at_ms) VALUES($1,$2,$3,$4)
ON CONFLICT(target_id) DO UPDATE SET generation=excluded.generation,phase=excluded.phase,updated_at_ms=excluded.updated_at_ms`
	}
	_, err := s.Store.db.ExecContext(ctx, query, state.TargetID, state.Generation, state.Phase, s.Store.now().UnixMilli())
	return err
}
