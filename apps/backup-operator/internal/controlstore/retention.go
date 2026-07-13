package controlstore

import (
	"context"
	"errors"
	"fmt"
	"time"
)

type RetentionPolicy struct {
	JobEvents time.Duration
	Audits    time.Duration
	BatchSize int
}

type RetentionResult struct {
	JobEventsArchived int64
	AuditsArchived    int64
}

func (s *Store) EnforceRetention(ctx context.Context, policy RetentionPolicy) (RetentionResult, error) {
	if policy.JobEvents <= 0 || policy.Audits <= 0 || policy.BatchSize < 1 || policy.BatchSize > 10_000 {
		return RetentionResult{}, errors.New("positive retention windows and a batch size between 1 and 10000 are required")
	}
	now := s.now()
	jobs, err := s.archiveJobEvents(ctx, now.Add(-policy.JobEvents), policy.BatchSize)
	if err != nil {
		return RetentionResult{}, err
	}
	audits, err := s.archiveAuditEvents(ctx, now.Add(-policy.Audits), policy.BatchSize)
	if err != nil {
		return RetentionResult{JobEventsArchived: jobs}, err
	}
	return RetentionResult{JobEventsArchived: jobs, AuditsArchived: audits}, nil
}

func (s *Store) archiveJobEvents(ctx context.Context, before time.Time, limit int) (int64, error) {
	insert := `INSERT INTO job_event_archive(id,job_id,step_name,event_type,payload_json,created_at_ms)
SELECT id,job_id,step_name,event_type,payload_json,created_at_ms FROM job_events WHERE created_at_ms<? ORDER BY id LIMIT ? ON CONFLICT DO NOTHING`
	remove := `DELETE FROM job_events WHERE id IN (SELECT id FROM job_events WHERE created_at_ms<? ORDER BY id LIMIT ?)`
	if s.dialect == Postgres {
		insert = `INSERT INTO job_event_archive(id,job_id,step_name,event_type,payload_json,created_at_ms)
SELECT id,job_id,step_name,event_type,payload_json,created_at_ms FROM job_events WHERE created_at_ms<$1 ORDER BY id LIMIT $2 ON CONFLICT DO NOTHING`
		remove = `DELETE FROM job_events WHERE id IN (SELECT id FROM job_events WHERE created_at_ms<$1 ORDER BY id LIMIT $2)`
	}
	return s.archiveAndDelete(ctx, insert, remove, before.UnixMilli(), limit)
}

func (s *Store) archiveAuditEvents(ctx context.Context, before time.Time, limit int) (int64, error) {
	insert := `INSERT INTO audit_event_archive(id,actor,action,target,payload_json,created_at_ms)
SELECT id,actor,action,target,payload_json,created_at_ms FROM audit_events WHERE created_at_ms<? ORDER BY id LIMIT ? ON CONFLICT DO NOTHING`
	remove := `DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE created_at_ms<? ORDER BY id LIMIT ?)`
	if s.dialect == Postgres {
		insert = `INSERT INTO audit_event_archive(id,actor,action,target,payload_json,created_at_ms)
SELECT id,actor,action,target,payload_json,created_at_ms FROM audit_events WHERE created_at_ms<$1 ORDER BY id LIMIT $2 ON CONFLICT DO NOTHING`
		remove = `DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE created_at_ms<$1 ORDER BY id LIMIT $2)`
	}
	return s.archiveAndDelete(ctx, insert, remove, before.UnixMilli(), limit)
}

func (s *Store) archiveAndDelete(ctx context.Context, insert, remove string, beforeMS int64, limit int) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, insert, beforeMS, limit); err != nil {
		return 0, fmt.Errorf("archive retained events: %w", err)
	}
	result, err := tx.ExecContext(ctx, remove, beforeMS, limit)
	if err != nil {
		return 0, fmt.Errorf("prune archived events: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return count, nil
}

type CursorWindow struct {
	Earliest int64
	Latest   int64
}

func (s *Store) EventCursorWindow(ctx context.Context, jobID string) (CursorWindow, error) {
	if jobID == "" {
		return CursorWindow{}, errors.New("job ID is required")
	}
	query := `SELECT COALESCE(MIN(id),0),COALESCE(MAX(id),0) FROM job_events WHERE job_id=?`
	if s.dialect == Postgres {
		query = `SELECT COALESCE(MIN(id),0),COALESCE(MAX(id),0) FROM job_events WHERE job_id=$1`
	}
	var result CursorWindow
	if err := s.db.QueryRowContext(ctx, query, jobID).Scan(&result.Earliest, &result.Latest); err != nil {
		return CursorWindow{}, err
	}
	archiveQuery := `SELECT COALESCE(MAX(id),0) FROM job_event_archive WHERE job_id=?`
	if s.dialect == Postgres {
		archiveQuery = `SELECT COALESCE(MAX(id),0) FROM job_event_archive WHERE job_id=$1`
	}
	var archivedLatest int64
	if err := s.db.QueryRowContext(ctx, archiveQuery, jobID).Scan(&archivedLatest); err != nil {
		return CursorWindow{}, err
	}
	if result.Earliest == 0 && archivedLatest > 0 {
		result.Earliest = archivedLatest + 1
	}
	if archivedLatest > result.Latest {
		result.Latest = archivedLatest
	}
	return result, nil
}

type JobSnapshot struct {
	JobID     string
	State     string
	UpdatedAt time.Time
	Cursor    int64
}

func (s *Store) CurrentJobSnapshot(ctx context.Context, jobID string) (JobSnapshot, error) {
	window, err := s.EventCursorWindow(ctx, jobID)
	if err != nil {
		return JobSnapshot{}, err
	}
	query := `SELECT id,state,updated_at_ms FROM jobs WHERE id=?`
	if s.dialect == Postgres {
		query = `SELECT id,state,updated_at_ms FROM jobs WHERE id=$1`
	}
	var snapshot JobSnapshot
	var updated int64
	if err := s.db.QueryRowContext(ctx, query, jobID).Scan(&snapshot.JobID, &snapshot.State, &updated); err != nil {
		return JobSnapshot{}, err
	}
	snapshot.UpdatedAt = time.UnixMilli(updated)
	snapshot.Cursor = window.Latest
	return snapshot, nil
}
