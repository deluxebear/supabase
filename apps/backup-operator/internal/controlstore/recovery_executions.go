package controlstore

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/recoveryexec"
)

func (s *Store) CreateRecoveryExecution(ctx context.Context, planID, fenceHandleID string, fencingToken int64) error {
	if planID == "" || fenceHandleID == "" || fencingToken <= 0 {
		return errors.New("plan, fence handle, and positive fencing token are required")
	}
	query := `INSERT INTO recovery_executions(plan_id, state, fencing_token, fence_handle_id, updated_at_ms)
VALUES(?, ?, ?, ?, ?) ON CONFLICT(plan_id) DO NOTHING`
	if s.dialect == Postgres {
		query = `INSERT INTO recovery_executions(plan_id, state, fencing_token, fence_handle_id, updated_at_ms)
VALUES($1, $2, $3, $4, $5) ON CONFLICT(plan_id) DO NOTHING`
	}
	_, err := s.db.ExecContext(ctx, query, planID, recoveryexec.StatePrepared, fencingToken, fenceHandleID, s.now().UnixMilli())
	return err
}

func (s *Store) Load(ctx context.Context, planID string) (recoveryexec.Execution, error) {
	query := `SELECT plan_id, state, original_pgdata, failed_pgdata, last_error, updated_at_ms, fencing_token, fence_handle_id
FROM recovery_executions WHERE plan_id=?`
	if s.dialect == Postgres {
		query = `SELECT plan_id, state, original_pgdata, failed_pgdata, last_error, updated_at_ms, fencing_token, fence_handle_id
FROM recovery_executions WHERE plan_id=$1`
	}
	var execution recoveryexec.Execution
	var updatedAt int64
	if err := s.db.QueryRowContext(ctx, query, planID).Scan(
		&execution.PlanID, &execution.State, &execution.OriginalPGDATA, &execution.FailedPGDATA,
		&execution.LastError, &updatedAt, &execution.FencingToken, &execution.FenceHandleID,
	); err != nil {
		return recoveryexec.Execution{}, err
	}
	execution.UpdatedAt = time.UnixMilli(updatedAt)
	return execution, nil
}

func (s *Store) Transition(ctx context.Context, planID string, from, to recoveryexec.State, mutate func(*recoveryexec.Execution)) error {
	if mutate == nil {
		return errors.New("recovery transition mutator is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	selectQuery := `SELECT plan_id, state, original_pgdata, failed_pgdata, last_error, updated_at_ms, fencing_token, fence_handle_id
FROM recovery_executions WHERE plan_id=?`
	if s.dialect == Postgres {
		selectQuery = `SELECT plan_id, state, original_pgdata, failed_pgdata, last_error, updated_at_ms, fencing_token, fence_handle_id
FROM recovery_executions WHERE plan_id=$1 FOR UPDATE`
	}
	var execution recoveryexec.Execution
	var updatedAt int64
	if err := tx.QueryRowContext(ctx, selectQuery, planID).Scan(
		&execution.PlanID, &execution.State, &execution.OriginalPGDATA, &execution.FailedPGDATA,
		&execution.LastError, &updatedAt, &execution.FencingToken, &execution.FenceHandleID,
	); err != nil {
		return err
	}
	if execution.State != from {
		return errors.New("recovery state compare-and-swap failed")
	}
	mutate(&execution)
	execution.State = to
	if execution.UpdatedAt.IsZero() {
		execution.UpdatedAt = s.now()
	}
	update := `UPDATE recovery_executions SET state=?, original_pgdata=?, failed_pgdata=?, last_error=?, updated_at_ms=?
WHERE plan_id=? AND state=?`
	args := []any{execution.State, execution.OriginalPGDATA, execution.FailedPGDATA, execution.LastError, execution.UpdatedAt.UnixMilli(), planID, from}
	if s.dialect == Postgres {
		update = `UPDATE recovery_executions SET state=$1, original_pgdata=$2, failed_pgdata=$3, last_error=$4, updated_at_ms=$5
WHERE plan_id=$6 AND state=$7`
	}
	result, err := tx.ExecContext(ctx, update, args...)
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
	return tx.Commit()
}
