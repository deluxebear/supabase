package controlstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/kubernetes"
)

type KubernetesRecoveryStore struct{ Store *Store }

func (s KubernetesRecoveryStore) Ensure(ctx context.Context, planID string, oldPVCUIDs []string) error {
	if s.Store == nil || planID == "" || len(oldPVCUIDs) == 0 {
		return errors.New("control store, plan, and original PVC UIDs are required")
	}
	payload, _ := json.Marshal(oldPVCUIDs)
	query := `INSERT INTO kubernetes_recovery_states(plan_id,phase,old_pvc_uids_json) VALUES(?,?,?) ON CONFLICT(plan_id) DO NOTHING`
	if s.Store.dialect == Postgres {
		query = `INSERT INTO kubernetes_recovery_states(plan_id,phase,old_pvc_uids_json) VALUES($1,$2,$3::jsonb) ON CONFLICT(plan_id) DO NOTHING`
	}
	_, err := s.Store.db.ExecContext(ctx, query, planID, kubernetes.PhasePlanned, string(payload))
	return err
}

func (s KubernetesRecoveryStore) LoadReplacement(ctx context.Context, planID string) (kubernetes.ReplacementState, error) {
	if s.Store == nil {
		return kubernetes.ReplacementState{}, errors.New("control store is required")
	}
	query := `SELECT plan_id,phase,stable_service_resource_version,old_statefulset_resource_version,old_pvc_uids_json,cleanup_after_ms FROM kubernetes_recovery_states WHERE plan_id=?`
	if s.Store.dialect == Postgres {
		query = `SELECT plan_id,phase,stable_service_resource_version,old_statefulset_resource_version,old_pvc_uids_json::text,cleanup_after_ms FROM kubernetes_recovery_states WHERE plan_id=$1`
	}
	var state kubernetes.ReplacementState
	var oldPVCs string
	var cleanup int64
	err := s.Store.db.QueryRowContext(ctx, query, planID).Scan(&state.PlanID, &state.Phase, &state.StableServiceResourceVersion, &state.OldStatefulSetResourceVersion, &oldPVCs, &cleanup)
	if err == nil {
		err = json.Unmarshal([]byte(oldPVCs), &state.OldPVCUIDs)
	}
	if cleanup > 0 {
		state.CleanupAfter = time.UnixMilli(cleanup).UTC()
	}
	return state, err
}

func (s KubernetesRecoveryStore) TransitionReplacement(ctx context.Context, planID string, from, to kubernetes.ReplacementPhase, mutate func(*kubernetes.ReplacementState)) error {
	if s.Store == nil {
		return errors.New("control store is required")
	}
	tx, err := s.Store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	query := `SELECT plan_id,phase,stable_service_resource_version,old_statefulset_resource_version,old_pvc_uids_json,cleanup_after_ms FROM kubernetes_recovery_states WHERE plan_id=?`
	if s.Store.dialect == Postgres {
		query = `SELECT plan_id,phase,stable_service_resource_version,old_statefulset_resource_version,old_pvc_uids_json::text,cleanup_after_ms FROM kubernetes_recovery_states WHERE plan_id=$1 FOR UPDATE`
	}
	var state kubernetes.ReplacementState
	var oldPVCs string
	var cleanup int64
	if err := tx.QueryRowContext(ctx, query, planID).Scan(&state.PlanID, &state.Phase, &state.StableServiceResourceVersion, &state.OldStatefulSetResourceVersion, &oldPVCs, &cleanup); err != nil {
		return err
	}
	if state.Phase != from {
		return errors.New("Kubernetes recovery state compare-and-swap failed")
	}
	if err := json.Unmarshal([]byte(oldPVCs), &state.OldPVCUIDs); err != nil {
		return err
	}
	if cleanup > 0 {
		state.CleanupAfter = time.UnixMilli(cleanup).UTC()
	}
	if mutate != nil {
		mutate(&state)
	}
	payload, _ := json.Marshal(state.OldPVCUIDs)
	update := `UPDATE kubernetes_recovery_states SET phase=?,stable_service_resource_version=?,old_statefulset_resource_version=?,old_pvc_uids_json=?,cleanup_after_ms=? WHERE plan_id=? AND phase=?`
	args := []any{to, state.StableServiceResourceVersion, state.OldStatefulSetResourceVersion, string(payload), state.CleanupAfter.UnixMilli(), planID, from}
	if s.Store.dialect == Postgres {
		update = `UPDATE kubernetes_recovery_states SET phase=$1,stable_service_resource_version=$2,old_statefulset_resource_version=$3,old_pvc_uids_json=$4::jsonb,cleanup_after_ms=$5 WHERE plan_id=$6 AND phase=$7`
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
