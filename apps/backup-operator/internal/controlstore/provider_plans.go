package controlstore

import (
	"context"
	"encoding/json"
	"errors"
)

func (s *Store) SaveProviderRestorePlan(ctx context.Context, planID, provider string, plan any) error {
	if s == nil || planID == "" || provider == "" || plan == nil {
		return errors.New("control store, plan ID, provider, and typed plan are required")
	}
	payload, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	query := `INSERT INTO provider_restore_plans(plan_id,provider,plan_json,created_at_ms) VALUES(?,?,?,?) ON CONFLICT(plan_id,provider) DO NOTHING`
	if s.dialect == Postgres {
		query = `INSERT INTO provider_restore_plans(plan_id,provider,plan_json,created_at_ms) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(plan_id,provider) DO NOTHING`
	}
	_, err = s.db.ExecContext(ctx, query, planID, provider, string(payload), s.now().UnixMilli())
	return err
}

func (s *Store) LoadProviderRestorePlan(ctx context.Context, planID, provider string, destination any) error {
	if s == nil || planID == "" || provider == "" || destination == nil {
		return errors.New("control store, plan ID, provider, and destination are required")
	}
	query := `SELECT plan_json FROM provider_restore_plans WHERE plan_id=? AND provider=?`
	if s.dialect == Postgres {
		query = `SELECT plan_json::text FROM provider_restore_plans WHERE plan_id=$1 AND provider=$2`
	}
	var payload string
	if err := s.db.QueryRowContext(ctx, query, planID, provider).Scan(&payload); err != nil {
		return err
	}
	return json.Unmarshal([]byte(payload), destination)
}
