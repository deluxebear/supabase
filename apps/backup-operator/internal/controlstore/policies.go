package controlstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

var ErrBackupPolicyNotFound = errors.New("backup policy not found")

const (
	StandardRetentionDays = 14
	StandardFullSchedule  = "0 2 * * *"
	StandardDiffSchedule  = "0 2 * * 1-6"
	StandardIncrSchedule  = "0 * * * *"
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
	RetentionDays      int
	FullSchedule       string
	DiffSchedule       string
	IncrSchedule       string
}

func (s *Store) UpsertBackupPolicy(ctx context.Context, policy BackupPolicyRecord) error {
	query := `INSERT INTO backup_policies(id,project_id,target_id,repository_id,enabled,backup_type,backup_from,designated_standby,max_standby_lag_bytes,schedule,next_run_at_ms,updated_at_ms,retention_days,full_schedule,diff_schedule,incr_schedule)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,backup_type=excluded.backup_type,backup_from=excluded.backup_from,designated_standby=excluded.designated_standby,max_standby_lag_bytes=excluded.max_standby_lag_bytes,schedule=excluded.schedule,next_run_at_ms=excluded.next_run_at_ms,updated_at_ms=excluded.updated_at_ms,retention_days=excluded.retention_days,full_schedule=excluded.full_schedule,diff_schedule=excluded.diff_schedule,incr_schedule=excluded.incr_schedule`
	if s.dialect == Postgres {
		query = `INSERT INTO backup_policies(id,project_id,target_id,repository_id,enabled,backup_type,backup_from,designated_standby,max_standby_lag_bytes,schedule,next_run_at_ms,updated_at_ms,retention_days,full_schedule,diff_schedule,incr_schedule)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,backup_type=excluded.backup_type,backup_from=excluded.backup_from,designated_standby=excluded.designated_standby,max_standby_lag_bytes=excluded.max_standby_lag_bytes,schedule=excluded.schedule,next_run_at_ms=excluded.next_run_at_ms,updated_at_ms=excluded.updated_at_ms,retention_days=excluded.retention_days,full_schedule=excluded.full_schedule,diff_schedule=excluded.diff_schedule,incr_schedule=excluded.incr_schedule`
	}
	if policy.RetentionDays == 0 {
		policy.RetentionDays = 30
	}
	if policy.FullSchedule == "" {
		policy.FullSchedule = policy.Schedule
	}
	_, err := s.db.ExecContext(ctx, query, policy.ID, policy.ProjectID, policy.TargetID, policy.RepositoryID, policy.Enabled, policy.BackupType, policy.BackupFrom, nullString(policy.DesignatedStandby), policy.MaxStandbyLagBytes, policy.Schedule, policy.NextRunAt.UnixMilli(), s.now().UnixMilli(), policy.RetentionDays, nullString(policy.FullSchedule), nullString(policy.DiffSchedule), nullString(policy.IncrSchedule))
	return err
}

func StandardBackupPolicy(projectID, targetID, repositoryID string, now time.Time) BackupPolicyRecord {
	schedules := map[string]string{"full": StandardFullSchedule, "diff": StandardDiffSchedule, "incr": StandardIncrSchedule}
	next := now.UTC().Add(24 * time.Hour)
	for _, schedule := range schedules {
		if candidate, err := nextStandardSchedule(schedule, now); err == nil && candidate.Before(next) {
			next = candidate
		}
	}
	return BackupPolicyRecord{
		ID: "standard-" + targetID, ProjectID: projectID, TargetID: targetID,
		RepositoryID: repositoryID, Enabled: true, BackupType: "incr", BackupFrom: "primary",
		Schedule: StandardIncrSchedule, NextRunAt: next, RetentionDays: StandardRetentionDays,
		FullSchedule: StandardFullSchedule, DiffSchedule: StandardDiffSchedule, IncrSchedule: StandardIncrSchedule,
	}
}

var nextStandardSchedule = func(schedule string, now time.Time) (time.Time, error) {
	// Kept local to the persistence package to avoid a scheduler import cycle.
	fields := map[string]time.Duration{
		StandardFullSchedule: 24 * time.Hour,
		StandardDiffSchedule: 24 * time.Hour,
		StandardIncrSchedule: time.Hour,
	}
	interval, ok := fields[schedule]
	if !ok {
		return time.Time{}, errors.New("unsupported standard schedule")
	}
	return now.UTC().Truncate(interval).Add(interval), nil
}

func (s *Store) GetBackupPolicy(ctx context.Context, targetID string) (BackupPolicyRecord, error) {
	query := `SELECT id,project_id,target_id,repository_id,enabled,backup_type,backup_from,COALESCE(designated_standby,''),max_standby_lag_bytes,schedule,next_run_at_ms,retention_days,COALESCE(full_schedule,''),COALESCE(diff_schedule,''),COALESCE(incr_schedule,'') FROM backup_policies WHERE target_id=? ORDER BY updated_at_ms DESC LIMIT 1`
	if s.dialect == Postgres {
		query = `SELECT id,project_id,target_id,repository_id,enabled,backup_type,backup_from,COALESCE(designated_standby,''),max_standby_lag_bytes,schedule,next_run_at_ms,retention_days,COALESCE(full_schedule,''),COALESCE(diff_schedule,''),COALESCE(incr_schedule,'') FROM backup_policies WHERE target_id=$1 ORDER BY updated_at_ms DESC LIMIT 1`
	}
	var p BackupPolicyRecord
	var next int64
	if err := s.db.QueryRowContext(ctx, query, targetID).Scan(&p.ID, &p.ProjectID, &p.TargetID, &p.RepositoryID, &p.Enabled, &p.BackupType, &p.BackupFrom, &p.DesignatedStandby, &p.MaxStandbyLagBytes, &p.Schedule, &next, &p.RetentionDays, &p.FullSchedule, &p.DiffSchedule, &p.IncrSchedule); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return p, ErrBackupPolicyNotFound
		}
		return p, err
	}
	p.NextRunAt = time.UnixMilli(next)
	return p, nil
}

func (s *Store) ListBackupManifests(ctx context.Context, targetID string) ([]BackupManifestRecord, error) {
	query := `SELECT m.provider_job_id,m.policy_id,m.repository_id,m.backup_label,m.backup_type,m.completed_at_ms,m.manifest_json FROM backup_manifests m JOIN backup_policies p ON p.id=m.policy_id WHERE p.target_id=? ORDER BY m.completed_at_ms DESC`
	if s.dialect == Postgres {
		query = `SELECT m.provider_job_id,m.policy_id,m.repository_id,m.backup_label,m.backup_type,m.completed_at_ms,m.manifest_json::text FROM backup_manifests m JOIN backup_policies p ON p.id=m.policy_id WHERE p.target_id=$1 ORDER BY m.completed_at_ms DESC`
	}
	rows, err := s.db.QueryContext(ctx, query, targetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BackupManifestRecord
	for rows.Next() {
		var m BackupManifestRecord
		var completed int64
		if err := rows.Scan(&m.ProviderJobID, &m.PolicyID, &m.RepositoryID, &m.BackupLabel, &m.BackupType, &completed, &m.ManifestJSON); err != nil {
			return nil, err
		}
		m.CompletedAt = time.UnixMilli(completed)
		out = append(out, m)
	}
	return out, rows.Err()
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
	query := `SELECT id,project_id,target_id,repository_id,enabled,backup_type,backup_from,COALESCE(designated_standby,''),max_standby_lag_bytes,schedule,next_run_at_ms,COALESCE(full_schedule,''),COALESCE(diff_schedule,''),COALESCE(incr_schedule,'')
FROM backup_policies WHERE enabled=1 AND next_run_at_ms<=? AND (claim_until_ms IS NULL OR claim_until_ms<?)
ORDER BY next_run_at_ms LIMIT ?`
	if s.dialect == Postgres {
		query = `SELECT id,project_id,target_id,repository_id,enabled,backup_type,backup_from,COALESCE(designated_standby,''),max_standby_lag_bytes,schedule,next_run_at_ms,COALESCE(full_schedule,''),COALESCE(diff_schedule,''),COALESCE(incr_schedule,'')
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
		if err := rows.Scan(&policy.ID, &policy.ProjectID, &policy.TargetID, &policy.RepositoryID, &policy.Enabled, &policy.BackupType, &policy.BackupFrom, &policy.DesignatedStandby, &policy.MaxStandbyLagBytes, &policy.Schedule, &next, &policy.FullSchedule, &policy.DiffSchedule, &policy.IncrSchedule); err != nil {
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

func (s *Store) CompletePolicyClaim(ctx context.Context, policyID, owner string, next time.Time, nextBackupType, nextSchedule string) error {
	query := "UPDATE backup_policies SET next_run_at_ms=?,backup_type=?,schedule=?,claim_owner=NULL,claim_until_ms=NULL,updated_at_ms=? WHERE id=? AND claim_owner=?"
	args := []any{next.UTC().UnixMilli(), nextBackupType, nextSchedule, s.now().UnixMilli(), policyID, owner}
	if s.dialect == Postgres {
		query = "UPDATE backup_policies SET next_run_at_ms=$1,backup_type=$2,schedule=$3,claim_owner=NULL,claim_until_ms=NULL,updated_at_ms=$4 WHERE id=$5 AND claim_owner=$6"
	}
	result, err := s.db.ExecContext(ctx, query, args...)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count != 1 {
		return errors.New("backup policy claim is no longer owned")
	}
	return nil
}

func (s *Store) ReleasePolicyClaim(ctx context.Context, policyID, owner string) error {
	query := "UPDATE backup_policies SET claim_owner=NULL,claim_until_ms=NULL,updated_at_ms=? WHERE id=? AND claim_owner=?"
	args := []any{s.now().UnixMilli(), policyID, owner}
	if s.dialect == Postgres {
		query = "UPDATE backup_policies SET claim_owner=NULL,claim_until_ms=NULL,updated_at_ms=$1 WHERE id=$2 AND claim_owner=$3"
	}
	_, err := s.db.ExecContext(ctx, query, args...)
	return err
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
