package controlstore

import (
	"context"
	"fmt"
	"time"
)

type BackupPolicyRecord struct {
	ID                 string
	ProjectID          string
	TargetID           string
	RepositoryID       string
	Enabled            bool
	BackupType         string
	BackupFrom         string
	DesignatedStandby  string
	MaxStandbyLagBytes int64
	Schedule           string
	NextRunAt          time.Time
}

func (s *Store) UpsertBackupPolicy(ctx context.Context, policy BackupPolicyRecord) error {
	query := `INSERT INTO backup_policies(id,project_id,target_id,repository_id,enabled,backup_type,backup_from,designated_standby,max_standby_lag_bytes,schedule,next_run_at_ms,updated_at_ms)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,backup_type=excluded.backup_type,backup_from=excluded.backup_from,designated_standby=excluded.designated_standby,max_standby_lag_bytes=excluded.max_standby_lag_bytes,schedule=excluded.schedule,next_run_at_ms=excluded.next_run_at_ms,updated_at_ms=excluded.updated_at_ms`
	if s.dialect == Postgres {
		query = `INSERT INTO backup_policies(id,project_id,target_id,repository_id,enabled,backup_type,backup_from,designated_standby,max_standby_lag_bytes,schedule,next_run_at_ms,updated_at_ms)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,backup_type=excluded.backup_type,backup_from=excluded.backup_from,designated_standby=excluded.designated_standby,max_standby_lag_bytes=excluded.max_standby_lag_bytes,schedule=excluded.schedule,next_run_at_ms=excluded.next_run_at_ms,updated_at_ms=excluded.updated_at_ms`
	}
	_, err := s.db.ExecContext(ctx, query, policy.ID, policy.ProjectID, policy.TargetID, policy.RepositoryID, policy.Enabled, policy.BackupType, policy.BackupFrom, nullString(policy.DesignatedStandby), policy.MaxStandbyLagBytes, policy.Schedule, policy.NextRunAt.UnixMilli(), s.now().UnixMilli())
	return err
}

func (s *Store) ClaimDuePolicies(ctx context.Context, owner string, limit int, ttl time.Duration) ([]BackupPolicyRecord, error) {
	if limit < 1 || limit > 100 {
		return nil, fmt.Errorf("claim limit must be between 1 and 100")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	now := s.now().UnixMilli()
	query := `SELECT id,project_id,target_id,repository_id,enabled,backup_type,backup_from,COALESCE(designated_standby,''),max_standby_lag_bytes,schedule,next_run_at_ms
FROM backup_policies WHERE enabled=1 AND next_run_at_ms<=? AND (claim_until_ms IS NULL OR claim_until_ms<?)
ORDER BY next_run_at_ms LIMIT ?`
	if s.dialect == Postgres {
		query = `SELECT id,project_id,target_id,repository_id,enabled,backup_type,backup_from,COALESCE(designated_standby,''),max_standby_lag_bytes,schedule,next_run_at_ms
FROM backup_policies WHERE enabled=TRUE AND next_run_at_ms<=$1 AND (claim_until_ms IS NULL OR claim_until_ms<$1)
ORDER BY next_run_at_ms FOR UPDATE SKIP LOCKED LIMIT $2`
	}
	args := []any{now, now, limit}
	if s.dialect == Postgres {
		args = []any{now, limit}
	}
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	var policies []BackupPolicyRecord
	for rows.Next() {
		var policy BackupPolicyRecord
		var next int64
		if err := rows.Scan(&policy.ID, &policy.ProjectID, &policy.TargetID, &policy.RepositoryID, &policy.Enabled, &policy.BackupType, &policy.BackupFrom, &policy.DesignatedStandby, &policy.MaxStandbyLagBytes, &policy.Schedule, &next); err != nil {
			rows.Close()
			return nil, err
		}
		policy.NextRunAt = time.UnixMilli(next)
		policies = append(policies, policy)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	update := "UPDATE backup_policies SET claim_owner=?,claim_until_ms=? WHERE id=?"
	if s.dialect == Postgres {
		update = "UPDATE backup_policies SET claim_owner=$1,claim_until_ms=$2 WHERE id=$3"
	}
	for _, policy := range policies {
		if _, err := tx.ExecContext(ctx, update, owner, s.now().Add(ttl).UnixMilli(), policy.ID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return policies, nil
}

type BackupManifestRecord struct {
	ProviderJobID string
	PolicyID      string
	RepositoryID  string
	BackupLabel   string
	BackupType    string
	CompletedAt   time.Time
	ManifestJSON  string
}

func (s *Store) RecordBackupManifest(ctx context.Context, manifest BackupManifestRecord) error {
	query := `INSERT INTO backup_manifests(provider_job_id,policy_id,repository_id,backup_label,backup_type,completed_at_ms,manifest_json)
VALUES(?,?,?,?,?,?,?) ON CONFLICT(provider_job_id) DO NOTHING`
	if s.dialect == Postgres {
		query = `INSERT INTO backup_manifests(provider_job_id,policy_id,repository_id,backup_label,backup_type,completed_at_ms,manifest_json)
VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(provider_job_id) DO NOTHING`
	}
	_, err := s.db.ExecContext(ctx, query, manifest.ProviderJobID, manifest.PolicyID, manifest.RepositoryID, manifest.BackupLabel, manifest.BackupType, manifest.CompletedAt.UnixMilli(), manifest.ManifestJSON)
	return err
}
