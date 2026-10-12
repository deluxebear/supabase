package controlstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrTaskEvidenceNotFound = errors.New("task evidence not found")

// LatestSuccessfulTaskEvidence returns immutable typed evidence for the newest
// successful capability execution in a recovery domain.
func (s *Store) LatestSuccessfulTaskEvidence(ctx context.Context, targetID, capability string) ([]byte, error) {
	evidence, _, err := s.LatestSuccessfulTaskEvidenceAt(ctx, targetID, capability)
	return evidence, err
}

// LatestSuccessfulTaskEvidenceAt also returns when the Operator received the
// evidence, which bounds its freshness without trusting the Agent's clock.
func (s *Store) LatestSuccessfulTaskEvidenceAt(ctx context.Context, targetID, capability string) ([]byte, time.Time, error) {
	if s == nil || targetID == "" || capability == "" {
		return nil, time.Time{}, errors.New("target and capability are required")
	}
	query := `SELECT r.evidence_json, r.received_at_ms
FROM task_results r
JOIN task_outbox o ON o.task_id=r.task_id
JOIN jobs j ON j.id=o.job_id
WHERE j.target_id=? AND o.capability=? AND r.succeeded=1
ORDER BY r.received_at_ms DESC, r.task_id DESC LIMIT 1`
	if s.dialect == Postgres {
		query = `SELECT r.evidence_json::text, r.received_at_ms
FROM task_results r
JOIN task_outbox o ON o.task_id=r.task_id
JOIN jobs j ON j.id=o.job_id
WHERE j.target_id=$1 AND o.capability=$2 AND r.succeeded=true
ORDER BY r.received_at_ms DESC, r.task_id DESC LIMIT 1`
	}
	var evidence []byte
	var receivedAtMS int64
	if err := s.db.QueryRowContext(ctx, query, targetID, capability).Scan(&evidence, &receivedAtMS); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, time.Time{}, ErrTaskEvidenceNotFound
		}
		return nil, time.Time{}, err
	}
	return append([]byte(nil), evidence...), time.UnixMilli(receivedAtMS).UTC(), nil
}

// HasActiveCapabilityJob reports whether a queued or running job of the
// capability exists for the target.
func (s *Store) HasActiveCapabilityJob(ctx context.Context, targetID, capability string) (bool, error) {
	query := `SELECT COUNT(*) FROM jobs j JOIN task_outbox o ON o.job_id=j.id
WHERE j.target_id=? AND o.capability=? AND j.state IN ('queued','running')`
	if s.dialect == Postgres {
		query = `SELECT COUNT(*) FROM jobs j JOIN task_outbox o ON o.job_id=j.id
WHERE j.target_id=$1 AND o.capability=$2 AND j.state IN ('queued','running')`
	}
	var count int
	if err := s.db.QueryRowContext(ctx, query, targetID, capability).Scan(&count); err != nil {
		return false, err
	}
	return count > 0, nil
}

// PruneCapabilityJobs deletes finished jobs of a read-only capability, such as
// periodic observations, that ended before the cutoff. The newest successful
// one is kept. It must never be used for capabilities that change data.
func (s *Store) PruneCapabilityJobs(ctx context.Context, capability string, before time.Time, limit int) (int, error) {
	if capability == "" || limit < 1 || limit > 10_000 {
		return 0, errors.New("capability and a batch size between 1 and 10000 are required")
	}
	selectQuery := `SELECT j.id, o.task_id FROM jobs j JOIN task_outbox o ON o.job_id=j.id
WHERE o.capability=? AND j.state IN ('succeeded','failed','cancelled','orphaned') AND j.updated_at_ms<?
AND o.task_id NOT IN (
  SELECT latest.task_id FROM (
    SELECT r.task_id, j2.target_id, ROW_NUMBER() OVER (PARTITION BY j2.target_id ORDER BY r.received_at_ms DESC, r.task_id DESC) AS position
    FROM task_results r JOIN task_outbox o2 ON o2.task_id=r.task_id JOIN jobs j2 ON j2.id=o2.job_id
    WHERE o2.capability=? AND r.succeeded=1
  ) latest WHERE latest.position=1
)
ORDER BY j.updated_at_ms LIMIT ?`
	if s.dialect == Postgres {
		selectQuery = `SELECT j.id, o.task_id FROM jobs j JOIN task_outbox o ON o.job_id=j.id
WHERE o.capability=$1 AND j.state IN ('succeeded','failed','cancelled','orphaned') AND j.updated_at_ms<$2
AND o.task_id NOT IN (
  SELECT latest.task_id FROM (
    SELECT r.task_id, j2.target_id, ROW_NUMBER() OVER (PARTITION BY j2.target_id ORDER BY r.received_at_ms DESC, r.task_id DESC) AS position
    FROM task_results r JOIN task_outbox o2 ON o2.task_id=r.task_id JOIN jobs j2 ON j2.id=o2.job_id
    WHERE o2.capability=$3 AND r.succeeded=true
  ) latest WHERE latest.position=1
)
ORDER BY j.updated_at_ms LIMIT $4`
	}
	rows, err := s.db.QueryContext(ctx, selectQuery, capability, before.UnixMilli(), capability, limit)
	if err != nil {
		return 0, err
	}
	type pruned struct{ jobID, taskID string }
	var items []pruned
	for rows.Next() {
		var item pruned
		if err := rows.Scan(&item.jobID, &item.taskID); err != nil {
			rows.Close()
			return 0, err
		}
		items = append(items, item)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return 0, err
	}
	deleted := 0
	for _, item := range items {
		if err := s.deleteJob(ctx, item.jobID, item.taskID); err != nil {
			return deleted, err
		}
		deleted++
	}
	return deleted, nil
}

func (s *Store) deleteJob(ctx context.Context, jobID, taskID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	statements := []struct {
		query string
		arg   string
	}{
		{"DELETE FROM task_results WHERE task_id=?", taskID},
		{"DELETE FROM task_fencing_tokens WHERE task_id=?", taskID},
		{"DELETE FROM task_outbox WHERE task_id=?", taskID},
		{"DELETE FROM job_events WHERE job_id=?", jobID},
		{"DELETE FROM job_steps WHERE job_id=?", jobID},
		{"DELETE FROM jobs WHERE id=?", jobID},
	}
	for _, statement := range statements {
		query := statement.query
		if s.dialect == Postgres {
			query = strings.Replace(query, "?", "$1", 1)
		}
		if _, err := tx.ExecContext(ctx, query, statement.arg); err != nil {
			return fmt.Errorf("prune job %s: %w", jobID, err)
		}
	}
	return tx.Commit()
}

// LatestRecoveryFinishedAt returns when the newest finished restore or
// rollback of a target ended, or the zero time when none has.
func (s *Store) LatestRecoveryFinishedAt(ctx context.Context, targetID string) (time.Time, error) {
	query := `SELECT COALESCE(MAX(updated_at_ms), 0) FROM jobs
WHERE target_id=? AND type IN ('restore','rollback') AND state IN ('succeeded','failed','cancelled','orphaned')`
	if s.dialect == Postgres {
		query = `SELECT COALESCE(MAX(updated_at_ms), 0) FROM jobs
WHERE target_id=$1 AND type IN ('restore','rollback') AND state IN ('succeeded','failed','cancelled','orphaned')`
	}
	var finishedAtMS int64
	if err := s.db.QueryRowContext(ctx, query, targetID).Scan(&finishedAtMS); err != nil {
		return time.Time{}, err
	}
	if finishedAtMS == 0 {
		return time.Time{}, nil
	}
	return time.UnixMilli(finishedAtMS).UTC(), nil
}
