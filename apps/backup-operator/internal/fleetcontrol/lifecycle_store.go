package fleetcontrol

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/fleetlifecycle"
)

var ErrLifecyclePlan = errors.New("lifecycle impact plan is missing, expired, consumed, or mismatched")

func (s *Store) CreateLifecyclePlan(ctx context.Context, plan fleetlifecycle.Plan, actor, correlationID string) error {
	raw, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	expires, err := time.Parse(time.RFC3339, plan.ExpiresAt)
	if err != nil {
		return err
	}
	now := s.now().UnixMilli()
	query := `INSERT INTO lifecycle_plans(id,project_ref,action,adapter,plan_hash,plan_json,expires_at_ms,actor,correlation_id,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)`
	if s.dialect == FleetPostgres {
		query = `INSERT INTO lifecycle_plans(id,project_ref,action,adapter,plan_hash,plan_json,expires_at_ms,actor,correlation_id,created_at_ms) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`
	}
	_, err = s.db.ExecContext(ctx, query, plan.ID, plan.ProjectRef, string(plan.Action), string(plan.Adapter), plan.Hash, string(raw), expires.UnixMilli(), actor, correlationID, now)
	return err
}

func (s *Store) ConsumeLifecyclePlan(ctx context.Context, projectRef, operationID string, document fleetlifecycle.Document) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	queryPlan := `SELECT plan_json FROM lifecycle_plans WHERE project_ref=? AND id=? AND plan_hash=? AND action=? AND adapter=? AND consumed_operation_id IS NULL AND expires_at_ms>?`
	argsPlan := []any{projectRef, document.PlanID, document.PlanHash, string(document.Action), string(document.Adapter), s.now().UnixMilli()}
	if s.dialect == FleetPostgres {
		queryPlan = `SELECT plan_json FROM lifecycle_plans WHERE project_ref=$1 AND id=$2 AND plan_hash=$3 AND action=$4 AND adapter=$5 AND consumed_operation_id IS NULL AND expires_at_ms>$6 FOR UPDATE`
	}
	var raw []byte
	if err := tx.QueryRowContext(ctx, queryPlan, argsPlan...).Scan(&raw); err != nil {
		return ErrLifecyclePlan
	}
	var plan fleetlifecycle.Plan
	if json.Unmarshal(raw, &plan) != nil {
		return ErrLifecyclePlan
	}
	hash, err := fleetlifecycle.HashPlan(plan)
	if err != nil || hash != plan.Hash || plan.Hash != document.PlanHash || !reflect.DeepEqual(plan.Parameters, document.Parameters) || !reflect.DeepEqual(plan.ComponentVersions, document.ComponentVersions) || plan.ExpiresAt != document.PlanExpiresAt {
		return ErrLifecyclePlan
	}
	query := `UPDATE lifecycle_plans SET consumed_operation_id=? WHERE project_ref=? AND id=? AND consumed_operation_id IS NULL`
	args := []any{operationID, projectRef, document.PlanID}
	if s.dialect == FleetPostgres {
		query = `UPDATE lifecycle_plans SET consumed_operation_id=$1 WHERE project_ref=$2 AND id=$3 AND consumed_operation_id IS NULL`
	}
	result, err := tx.ExecContext(ctx, query, args...)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return ErrLifecyclePlan
	}
	return tx.Commit()
}
