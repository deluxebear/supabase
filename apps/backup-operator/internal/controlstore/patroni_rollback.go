package controlstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/patroni"
)

type PatroniRollbackStore struct{ Store *Store }

func (s PatroniRollbackStore) EnsurePatroniRollback(ctx context.Context, state patroni.RollbackState) error {
	if s.Store == nil || state.PlanID == "" || state.Leader == "" || len(state.Nodes) == 0 || state.RollbackUntil.IsZero() {
		return errors.New("complete Patroni rollback baseline is required")
	}
	payload, _ := json.Marshal(state)
	query := `INSERT INTO patroni_rollback_states(plan_id,phase,state_json,rollback_until_ms) VALUES(?,?,?,?) ON CONFLICT(plan_id) DO NOTHING`
	if s.Store.dialect == Postgres {
		query = `INSERT INTO patroni_rollback_states(plan_id,phase,state_json,rollback_until_ms) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(plan_id) DO NOTHING`
	}
	_, err := s.Store.db.ExecContext(ctx, query, state.PlanID, state.Phase, string(payload), state.RollbackUntil.UnixMilli())
	return err
}

func (s PatroniRollbackStore) LoadPatroniRollback(ctx context.Context, planID string) (patroni.RollbackState, error) {
	if s.Store == nil {
		return patroni.RollbackState{}, errors.New("control store is required")
	}
	query := `SELECT phase,state_json,rollback_until_ms FROM patroni_rollback_states WHERE plan_id=?`
	if s.Store.dialect == Postgres {
		query = `SELECT phase,state_json::text,rollback_until_ms FROM patroni_rollback_states WHERE plan_id=$1`
	}
	var state patroni.RollbackState
	var payload string
	var deadline int64
	if err := s.Store.db.QueryRowContext(ctx, query, planID).Scan(&state.Phase, &payload, &deadline); err != nil {
		return state, err
	}
	if err := json.Unmarshal([]byte(payload), &state); err != nil {
		return state, err
	}
	state.RollbackUntil = time.UnixMilli(deadline).UTC()
	return state, nil
}

func (s PatroniRollbackStore) TransitionPatroniRollback(ctx context.Context, planID string, from, to patroni.RollbackPhase) error {
	if s.Store == nil {
		return errors.New("control store is required")
	}
	query := `UPDATE patroni_rollback_states SET phase=?,state_json=json_set(state_json,'$.Phase',?) WHERE plan_id=? AND phase=?`
	args := []any{to, to, planID, from}
	if s.Store.dialect == Postgres {
		query = `UPDATE patroni_rollback_states SET phase=$1,state_json=jsonb_set(state_json,'{Phase}',to_jsonb($2::text)) WHERE plan_id=$3 AND phase=$4`
	}
	result, err := s.Store.db.ExecContext(ctx, query, args...)
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil || rows != 1 {
		if err == nil {
			err = sql.ErrNoRows
		}
		return err
	}
	return nil
}
