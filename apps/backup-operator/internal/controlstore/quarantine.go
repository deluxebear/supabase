package controlstore

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

type Quarantine struct {
	ID            string
	PlanID        string
	ResourceType  string
	ResourceRef   string
	RollbackUntil time.Time
	ManualLock    bool
}

func (s *Store) RegisterQuarantine(ctx context.Context, quarantine Quarantine) error {
	if quarantine.ID == "" || quarantine.PlanID == "" || quarantine.ResourceType == "" || quarantine.ResourceRef == "" || !s.now().Before(quarantine.RollbackUntil) {
		return errors.New("valid quarantine identity and future rollback retention are required")
	}
	now := s.now().UnixMilli()
	query := `INSERT INTO quarantines(id, plan_id, resource_type, resource_ref, rollback_until_ms, manual_lock, created_at_ms, updated_at_ms)
VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
	if s.dialect == Postgres {
		query = `INSERT INTO quarantines(id, plan_id, resource_type, resource_ref, rollback_until_ms, manual_lock, created_at_ms, updated_at_ms)
VALUES($1, $2, $3, $4, $5, $6, $7, $8)`
	}
	_, err := s.db.ExecContext(ctx, query, quarantine.ID, quarantine.PlanID, quarantine.ResourceType, quarantine.ResourceRef, quarantine.RollbackUntil.UnixMilli(), quarantine.ManualLock, now, now)
	return err
}

func (s *Store) ClaimQuarantineCleanup(ctx context.Context, actor string, limit int) ([]Quarantine, error) {
	if actor == "" || limit < 1 || limit > 100 {
		return nil, errors.New("actor and cleanup limit between 1 and 100 are required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	now := s.now().UnixMilli()
	query := `SELECT id, plan_id, resource_type, resource_ref, rollback_until_ms, manual_lock
FROM quarantines WHERE state='quarantined' AND manual_lock=? AND rollback_until_ms<? ORDER BY rollback_until_ms LIMIT ?`
	args := []any{false, now, limit}
	if s.dialect == Postgres {
		query = `SELECT id, plan_id, resource_type, resource_ref, rollback_until_ms, manual_lock
FROM quarantines WHERE state='quarantined' AND manual_lock=false AND rollback_until_ms<$1
ORDER BY rollback_until_ms FOR UPDATE SKIP LOCKED LIMIT $2`
		args = []any{now, limit}
	}
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	var quarantines []Quarantine
	for rows.Next() {
		var item Quarantine
		var rollbackUntil int64
		if err := rows.Scan(&item.ID, &item.PlanID, &item.ResourceType, &item.ResourceRef, &rollbackUntil, &item.ManualLock); err != nil {
			rows.Close()
			return nil, err
		}
		item.RollbackUntil = time.UnixMilli(rollbackUntil)
		quarantines = append(quarantines, item)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	update := `UPDATE quarantines SET state='cleanup_pending', updated_at_ms=? WHERE id=? AND state='quarantined' AND manual_lock=? AND rollback_until_ms<?`
	if s.dialect == Postgres {
		update = `UPDATE quarantines SET state='cleanup_pending', updated_at_ms=$1 WHERE id=$2 AND state='quarantined' AND manual_lock=false AND rollback_until_ms<$3`
	}
	for _, item := range quarantines {
		var result sql.Result
		if s.dialect == Postgres {
			result, err = tx.ExecContext(ctx, update, now, item.ID, now)
		} else {
			result, err = tx.ExecContext(ctx, update, now, item.ID, false, now)
		}
		if err != nil {
			return nil, err
		}
		count, _ := result.RowsAffected()
		if count != 1 {
			return nil, errors.New("quarantine cleanup guard changed during claim")
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return quarantines, nil
}

func (s *Store) CompleteQuarantineCleanup(ctx context.Context, id, actor string, cleanupErr error) error {
	if id == "" || actor == "" {
		return errors.New("quarantine and actor are required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	state, action := "deleted", "quarantine.delete"
	payload := `{"result":"success"}`
	if cleanupErr != nil {
		state, action, payload = "quarantined", "quarantine.delete_failed", `{"result":"failed"}`
	}
	now := s.now().UnixMilli()
	update := "UPDATE quarantines SET state=?, updated_at_ms=? WHERE id=? AND state='cleanup_pending'"
	audit := "INSERT INTO audit_events(actor, action, target, payload_json, created_at_ms) VALUES(?, ?, ?, ?, ?)"
	if s.dialect == Postgres {
		update = "UPDATE quarantines SET state=$1, updated_at_ms=$2 WHERE id=$3 AND state='cleanup_pending'"
		audit = "INSERT INTO audit_events(actor, action, target, payload_json, created_at_ms) VALUES($1, $2, $3, $4::jsonb, $5)"
	}
	result, err := tx.ExecContext(ctx, update, state, now, id)
	if err != nil {
		return err
	}
	count, _ := result.RowsAffected()
	if count != 1 {
		return errors.New("quarantine is not pending cleanup")
	}
	if _, err := tx.ExecContext(ctx, audit, actor, action, id, payload, now); err != nil {
		return err
	}
	return tx.Commit()
}
