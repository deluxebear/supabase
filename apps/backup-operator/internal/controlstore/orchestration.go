package controlstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
)

var ErrJobNotFound = errors.New("job not found")
var ErrRollbackUnavailable = errors.New("rollback is only available for a succeeded restore job")

type JobRecord struct {
	ID             string    `json:"id"`
	ProjectID      string    `json:"projectId"`
	TargetID       string    `json:"targetId"`
	Type           string    `json:"type"`
	State          string    `json:"state"`
	IdempotencyKey string    `json:"idempotencyKey,omitempty"`
	PlanHash       string    `json:"planHash"`
	ErrorCode      string    `json:"errorCode,omitempty"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
	Steps          []JobStep `json:"steps"`
}

type JobStep struct {
	Name      string    `json:"name"`
	State     string    `json:"state"`
	Attempt   int       `json:"attempt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type CreateJobInput struct {
	ID             string
	ProjectID      string
	TargetID       string
	Type           string
	IdempotencyKey string
	PlanHash       string
	StepName       string
	Capability     string
	TargetNodeID   string
	Payload        []byte
	FencingToken   int64
}

func (s *Store) CreateJob(ctx context.Context, input CreateJobInput) (JobRecord, bool, error) {
	if input.ID == "" || input.ProjectID == "" || input.TargetID == "" || input.Type == "" || input.IdempotencyKey == "" || input.PlanHash == "" || input.StepName == "" || input.Capability == "" || input.TargetNodeID == "" {
		return JobRecord{}, false, errors.New("complete job, target, step, and dispatch identity is required")
	}
	if len(input.Payload) == 0 {
		input.Payload = []byte("{}")
	}
	if !json.Valid(input.Payload) {
		return JobRecord{}, false, errors.New("job payload must be valid JSON")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return JobRecord{}, false, err
	}
	defer tx.Rollback()
	now := s.now().UnixMilli()
	jobQuery := `INSERT INTO jobs(id, project_id, target_id, type, state, idempotency_key, plan_hash, input_json, created_at_ms, updated_at_ms)
VALUES(?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?) ON CONFLICT(project_id, target_id, idempotency_key) DO NOTHING`
	if s.dialect == Postgres {
		jobQuery = `INSERT INTO jobs(id, project_id, target_id, type, state, idempotency_key, plan_hash, input_json, created_at_ms, updated_at_ms)
VALUES($1, $2, $3, $4, 'queued', $5, $6, $7::jsonb, $8, $9) ON CONFLICT(project_id, target_id, idempotency_key) DO NOTHING`
	}
	result, err := tx.ExecContext(ctx, jobQuery, input.ID, input.ProjectID, input.TargetID, input.Type, input.IdempotencyKey, input.PlanHash, string(input.Payload), now, now)
	if err != nil {
		return JobRecord{}, false, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return JobRecord{}, false, err
	}
	created := rows == 1
	if created {
		taskID := input.ID + "/" + input.StepName
		if destructiveCapability(input.Capability) {
			input.FencingToken, err = s.allocateTaskFencingToken(ctx, tx, taskID, input.TargetID, input.TargetNodeID)
			if err != nil {
				return JobRecord{}, false, err
			}
		}
		stepQuery := "INSERT INTO job_steps(job_id, name, state, fencing_token, updated_at_ms) VALUES(?, ?, 'queued', ?, ?)"
		outboxQuery := `INSERT INTO task_outbox(task_id, job_id, step_name, capability, target_node_id, idempotency_key, payload, created_at_ms)
VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
		eventQuery := "INSERT INTO job_events(job_id, step_name, event_type, payload_json, created_at_ms) VALUES(?, ?, 'job_queued', '{}', ?)"
		if s.dialect == Postgres {
			stepQuery = "INSERT INTO job_steps(job_id, name, state, fencing_token, updated_at_ms) VALUES($1, $2, 'queued', $3, $4)"
			outboxQuery = `INSERT INTO task_outbox(task_id, job_id, step_name, capability, target_node_id, idempotency_key, payload, created_at_ms)
VALUES($1, $2, $3, $4, $5, $6, $7, $8)`
			eventQuery = "INSERT INTO job_events(job_id, step_name, event_type, payload_json, created_at_ms) VALUES($1, $2, 'job_queued', '{}'::jsonb, $3)"
		}
		if _, err = tx.ExecContext(ctx, stepQuery, input.ID, input.StepName, input.FencingToken, now); err != nil {
			return JobRecord{}, false, err
		}
		if _, err = tx.ExecContext(ctx, outboxQuery, taskID, input.ID, input.StepName, input.Capability, input.TargetNodeID, input.IdempotencyKey+"/"+input.StepName, input.Payload, now); err != nil {
			return JobRecord{}, false, err
		}
		if _, err = tx.ExecContext(ctx, eventQuery, input.ID, input.StepName, now); err != nil {
			return JobRecord{}, false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return JobRecord{}, false, err
	}
	jobID := input.ID
	if !created {
		query := "SELECT id FROM jobs WHERE project_id=? AND target_id=? AND idempotency_key=?"
		if s.dialect == Postgres {
			query = "SELECT id FROM jobs WHERE project_id=$1 AND target_id=$2 AND idempotency_key=$3"
		}
		if err := s.db.QueryRowContext(ctx, query, input.ProjectID, input.TargetID, input.IdempotencyKey).Scan(&jobID); err != nil {
			return JobRecord{}, false, err
		}
	}
	job, err := s.GetJob(ctx, jobID)
	return job, created, err
}

func (s *Store) GetJob(ctx context.Context, id string) (JobRecord, error) {
	query := `SELECT id, project_id, target_id, type, state, COALESCE(idempotency_key,''), plan_hash, COALESCE(error_code,''), created_at_ms, updated_at_ms FROM jobs WHERE id=?`
	if s.dialect == Postgres {
		query = `SELECT id, project_id, target_id, type, state, COALESCE(idempotency_key,''), plan_hash, COALESCE(error_code,''), created_at_ms, updated_at_ms FROM jobs WHERE id=$1`
	}
	var job JobRecord
	var created, updated int64
	if err := s.db.QueryRowContext(ctx, query, id).Scan(&job.ID, &job.ProjectID, &job.TargetID, &job.Type, &job.State, &job.IdempotencyKey, &job.PlanHash, &job.ErrorCode, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return JobRecord{}, ErrJobNotFound
		}
		return JobRecord{}, err
	}
	job.CreatedAt, job.UpdatedAt = time.UnixMilli(created), time.UnixMilli(updated)
	stepQuery := "SELECT name, state, attempt, updated_at_ms FROM job_steps WHERE job_id=? ORDER BY name"
	if s.dialect == Postgres {
		stepQuery = "SELECT name, state, attempt, updated_at_ms FROM job_steps WHERE job_id=$1 ORDER BY name"
	}
	rows, err := s.db.QueryContext(ctx, stepQuery, id)
	if err != nil {
		return JobRecord{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var step JobStep
		var at int64
		if err := rows.Scan(&step.Name, &step.State, &step.Attempt, &at); err != nil {
			return JobRecord{}, err
		}
		step.UpdatedAt = time.UnixMilli(at)
		job.Steps = append(job.Steps, step)
	}
	return job, rows.Err()
}

func (s *Store) CreateRollbackJob(ctx context.Context, originalID string) (JobRecord, bool, error) {
	original, err := s.GetJob(ctx, originalID)
	if err != nil {
		return JobRecord{}, false, err
	}
	if original.Type != "restore" || original.State != "succeeded" {
		return JobRecord{}, false, ErrRollbackUnavailable
	}
	plan, err := s.restoreTaskPlan(ctx, original.ID)
	if err != nil {
		return JobRecord{}, false, err
	}
	// Rollback receives a fresh dispatch deadline. Provider strategies still
	// enforce their durable rollback window from the original execution state.
	plan.ExpiresAt = s.now().Add(15 * time.Minute)
	capability, payload, err := providerRestoreTask(plan, "rollback")
	if err != nil {
		return JobRecord{}, false, err
	}
	var safety restoreplan.SafetyInputs
	if err := json.Unmarshal([]byte(plan.SafetyInputJSON), &safety); err != nil || safety.TargetNodeID == "" {
		return JobRecord{}, false, errors.New("rollback restore plan lacks a typed target node")
	}
	return s.CreateJob(ctx, CreateJobInput{ID: original.ID + "-rollback", ProjectID: original.ProjectID, TargetID: original.TargetID, Type: "rollback", IdempotencyKey: "rollback/" + original.ID, PlanHash: original.PlanHash, StepName: "rollback", Capability: capability, TargetNodeID: safety.TargetNodeID, Payload: payload})
}

func (s *Store) restoreTaskPlan(ctx context.Context, jobID string) (ConfirmedRestorePlan, error) {
	query := `SELECT rp.id,rp.job_id,rp.plan_hash,rp.safety_input_json,rp.expires_at_ms
FROM restore_plans rp WHERE rp.job_id=?`
	if s.dialect == Postgres {
		query = `SELECT rp.id,rp.job_id,rp.plan_hash,rp.safety_input_json,rp.expires_at_ms
FROM restore_plans rp WHERE rp.job_id=$1`
	}
	var plan ConfirmedRestorePlan
	var expiresAt int64
	if err := s.db.QueryRowContext(ctx, query, jobID).Scan(&plan.ID, &plan.JobID, &plan.PlanHash, &plan.SafetyInputJSON, &expiresAt); err != nil {
		return ConfirmedRestorePlan{}, fmt.Errorf("load restore plan for rollback: %w", err)
	}
	plan.ExpiresAt = time.UnixMilli(expiresAt).UTC()
	return plan, nil
}

func (s *Store) MarkOutboxDelivered(ctx context.Context, taskID, owner string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var jobID, stepName string
	lookup := "SELECT job_id, step_name FROM task_outbox WHERE task_id=? AND state='pending' AND claim_owner=?"
	if s.dialect == Postgres {
		lookup = "SELECT job_id, step_name FROM task_outbox WHERE task_id=$1 AND state='pending' AND claim_owner=$2 FOR UPDATE"
	}
	if err := tx.QueryRowContext(ctx, lookup, taskID, owner).Scan(&jobID, &stepName); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			stateQuery := "SELECT state FROM task_outbox WHERE task_id=?"
			if s.dialect == Postgres {
				stateQuery = "SELECT state FROM task_outbox WHERE task_id=$1"
			}
			var state string
			if stateErr := tx.QueryRowContext(ctx, stateQuery, taskID).Scan(&state); stateErr == nil && state == "completed" {
				return true, tx.Commit()
			}
			return false, nil
		}
		return false, err
	}
	now := s.now().UnixMilli()
	outboxQuery := "UPDATE task_outbox SET state='delivered', delivered_at_ms=?, claim_until_ms=NULL WHERE task_id=?"
	stepQuery := "UPDATE job_steps SET state='running', attempt=attempt+1, updated_at_ms=? WHERE job_id=? AND name=? AND state='queued'"
	jobQuery := "UPDATE jobs SET state='running', updated_at_ms=? WHERE id=? AND state='queued'"
	eventQuery := "INSERT INTO job_events(job_id, step_name, event_type, payload_json, created_at_ms) VALUES(?, ?, 'task_dispatched', '{}', ?)"
	if s.dialect == Postgres {
		outboxQuery = "UPDATE task_outbox SET state='delivered', delivered_at_ms=$1, claim_until_ms=NULL WHERE task_id=$2"
		stepQuery = "UPDATE job_steps SET state='running', attempt=attempt+1, updated_at_ms=$1 WHERE job_id=$2 AND name=$3 AND state='queued'"
		jobQuery = "UPDATE jobs SET state='running', updated_at_ms=$1 WHERE id=$2 AND state='queued'"
		eventQuery = "INSERT INTO job_events(job_id, step_name, event_type, payload_json, created_at_ms) VALUES($1, $2, 'task_dispatched', '{}'::jsonb, $3)"
	}
	for _, statement := range []struct {
		query string
		args  []any
	}{{outboxQuery, []any{now, taskID}}, {stepQuery, []any{now, jobID, stepName}}, {jobQuery, []any{now, jobID}}, {eventQuery, []any{jobID, stepName, now}}} {
		if _, err := tx.ExecContext(ctx, statement.query, statement.args...); err != nil {
			return false, err
		}
	}
	return true, tx.Commit()
}

func (s *Store) ReleaseOutbox(ctx context.Context, taskID, owner string) error {
	query := "UPDATE task_outbox SET claim_owner=NULL, claim_until_ms=NULL WHERE task_id=? AND state='pending' AND claim_owner=?"
	if s.dialect == Postgres {
		query = "UPDATE task_outbox SET claim_owner=NULL, claim_until_ms=NULL WHERE task_id=$1 AND state='pending' AND claim_owner=$2"
	}
	_, err := s.db.ExecContext(ctx, query, taskID, owner)
	return err
}

func (s *Store) ReconcileTaskResult(ctx context.Context, taskID string, succeeded bool, evidence []byte, errorCode string) (bool, error) {
	if len(evidence) == 0 {
		evidence = []byte("{}")
	}
	if len(evidence) > 1<<20 || !json.Valid(evidence) {
		return false, errors.New("task evidence must be valid JSON no larger than 1 MiB")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var jobID, stepName, state string
	query := "SELECT job_id, step_name, state FROM task_outbox WHERE task_id=?"
	if s.dialect == Postgres {
		query = "SELECT job_id, step_name, state FROM task_outbox WHERE task_id=$1 FOR UPDATE"
	}
	if err := tx.QueryRowContext(ctx, query, taskID).Scan(&jobID, &stepName, &state); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, ErrJobNotFound
		}
		return false, err
	}
	if state == "completed" {
		return false, nil
	}
	now := s.now().UnixMilli()
	insert := "INSERT INTO task_results(task_id, succeeded, evidence_json, error_code, received_at_ms) VALUES(?, ?, ?, ?, ?) ON CONFLICT(task_id) DO NOTHING"
	if s.dialect == Postgres {
		insert = "INSERT INTO task_results(task_id, succeeded, evidence_json, error_code, received_at_ms) VALUES($1, $2, $3::jsonb, $4, $5) ON CONFLICT(task_id) DO NOTHING"
	}
	result, err := tx.ExecContext(ctx, insert, taskID, succeeded, string(evidence), nullString(errorCode), now)
	if err != nil {
		return false, err
	}
	inserted, _ := result.RowsAffected()
	if inserted == 0 {
		return false, nil
	}
	stepState, jobState, eventType := "succeeded", "succeeded", "task_succeeded"
	if !succeeded {
		stepState, jobState, eventType = "failed", "failed", "task_failed"
	}
	outboxUpdate := "UPDATE task_outbox SET state='completed', delivered_at_ms=COALESCE(delivered_at_ms, ?) WHERE task_id=?"
	stepUpdate := "UPDATE job_steps SET state=?, result_json=?, updated_at_ms=? WHERE job_id=? AND name=? AND state NOT IN ('succeeded','failed','cancelled')"
	jobUpdate := "UPDATE jobs SET state=?, error_code=?, result_json=?, updated_at_ms=? WHERE id=? AND state NOT IN ('succeeded','failed','cancelled')"
	eventInsert := "INSERT INTO job_events(job_id, step_name, event_type, payload_json, created_at_ms) VALUES(?, ?, ?, ?, ?)"
	if s.dialect == Postgres {
		outboxUpdate = "UPDATE task_outbox SET state='completed', delivered_at_ms=COALESCE(delivered_at_ms, $1) WHERE task_id=$2"
		stepUpdate = "UPDATE job_steps SET state=$1, result_json=$2::jsonb, updated_at_ms=$3 WHERE job_id=$4 AND name=$5 AND state NOT IN ('succeeded','failed','cancelled')"
		jobUpdate = "UPDATE jobs SET state=$1, error_code=$2, result_json=$3::jsonb, updated_at_ms=$4 WHERE id=$5 AND state NOT IN ('succeeded','failed','cancelled')"
		eventInsert = "INSERT INTO job_events(job_id, step_name, event_type, payload_json, created_at_ms) VALUES($1, $2, $3, $4::jsonb, $5)"
	}
	for _, statement := range []struct {
		query string
		args  []any
	}{{outboxUpdate, []any{now, taskID}}, {stepUpdate, []any{stepState, string(evidence), now, jobID, stepName}}, {jobUpdate, []any{jobState, nullString(errorCode), string(evidence), now, jobID}}, {eventInsert, []any{jobID, stepName, eventType, string(evidence), now}}} {
		if _, err := tx.ExecContext(ctx, statement.query, statement.args...); err != nil {
			return false, err
		}
	}
	return true, tx.Commit()
}

func (s *Store) CancelJob(ctx context.Context, id string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	now := s.now().UnixMilli()
	jobQuery := "UPDATE jobs SET state='cancelled', updated_at_ms=? WHERE id=? AND state NOT IN ('succeeded','failed','cancelled')"
	stepQuery := "UPDATE job_steps SET state='cancelled', updated_at_ms=? WHERE job_id=? AND state NOT IN ('succeeded','failed','cancelled')"
	outboxQuery := "UPDATE task_outbox SET state='cancelled', claim_until_ms=NULL WHERE job_id=? AND state IN ('pending','delivered')"
	eventQuery := "INSERT INTO job_events(job_id, event_type, payload_json, created_at_ms) VALUES(?, 'job_cancelled', '{}', ?)"
	if s.dialect == Postgres {
		jobQuery = "UPDATE jobs SET state='cancelled', updated_at_ms=$1 WHERE id=$2 AND state NOT IN ('succeeded','failed','cancelled')"
		stepQuery = "UPDATE job_steps SET state='cancelled', updated_at_ms=$1 WHERE job_id=$2 AND state NOT IN ('succeeded','failed','cancelled')"
		outboxQuery = "UPDATE task_outbox SET state='cancelled', claim_until_ms=NULL WHERE job_id=$1 AND state IN ('pending','delivered')"
		eventQuery = "INSERT INTO job_events(job_id, event_type, payload_json, created_at_ms) VALUES($1, 'job_cancelled', '{}'::jsonb, $2)"
	}
	result, err := tx.ExecContext(ctx, jobQuery, now, id)
	if err != nil {
		return false, err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return false, tx.Commit()
	}
	if _, err := tx.ExecContext(ctx, stepQuery, now, id); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, outboxQuery, id); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, eventQuery, id, now); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

func (s *Store) RetryJob(ctx context.Context, id string) (bool, error) {
	job, err := s.GetJob(ctx, id)
	if err != nil {
		return false, err
	}
	if job.State != "failed" || len(job.Steps) != 1 {
		return false, nil
	}
	now := s.now().UnixMilli()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	queries := []string{
		"UPDATE jobs SET state='queued', error_code=NULL, updated_at_ms=? WHERE id=? AND state='failed'",
		"UPDATE job_steps SET state='queued', attempt=attempt+1, updated_at_ms=? WHERE job_id=? AND state='failed'",
		"UPDATE task_outbox SET state='pending', claim_owner=NULL, claim_until_ms=NULL, delivered_at_ms=NULL WHERE job_id=? AND state='completed'",
		"DELETE FROM task_results WHERE task_id IN (SELECT task_id FROM task_outbox WHERE job_id=?)",
		"INSERT INTO job_events(job_id, event_type, payload_json, created_at_ms) VALUES(?, 'job_retried', '{}', ?)",
	}
	args := [][]any{{now, id}, {now, id}, {id}, {id}, {id, now}}
	if s.dialect == Postgres {
		queries = []string{
			"UPDATE jobs SET state='queued', error_code=NULL, updated_at_ms=$1 WHERE id=$2 AND state='failed'",
			"UPDATE job_steps SET state='queued', attempt=attempt+1, updated_at_ms=$1 WHERE job_id=$2 AND state='failed'",
			"UPDATE task_outbox SET state='pending', claim_owner=NULL, claim_until_ms=NULL, delivered_at_ms=NULL WHERE job_id=$1 AND state='completed'",
			"DELETE FROM task_results WHERE task_id IN (SELECT task_id FROM task_outbox WHERE job_id=$1)",
			"INSERT INTO job_events(job_id, event_type, payload_json, created_at_ms) VALUES($1, 'job_retried', '{}'::jsonb, $2)",
		}
	}
	result, err := tx.ExecContext(ctx, queries[0], args[0]...)
	if err != nil {
		return false, fmt.Errorf("retry job: %w", err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	if changed != 1 {
		return false, tx.Commit()
	}
	for i := 1; i < len(queries); i++ {
		if _, err := tx.ExecContext(ctx, queries[i], args[i]...); err != nil {
			return false, fmt.Errorf("retry job: %w", err)
		}
	}
	return true, tx.Commit()
}

func (s *Store) MarkOrphanedTasks(ctx context.Context, before time.Time, limit int) (int, error) {
	if limit < 1 || limit > 1000 {
		return 0, errors.New("orphan limit must be between 1 and 1000")
	}
	query := `SELECT task_id FROM task_outbox WHERE state='delivered' AND delivered_at_ms<?
AND NOT EXISTS (SELECT 1 FROM task_results WHERE task_results.task_id=task_outbox.task_id) ORDER BY delivered_at_ms LIMIT ?`
	if s.dialect == Postgres {
		query = `SELECT task_id FROM task_outbox WHERE state='delivered' AND delivered_at_ms<$1
AND NOT EXISTS (SELECT 1 FROM task_results WHERE task_results.task_id=task_outbox.task_id) ORDER BY delivered_at_ms FOR UPDATE SKIP LOCKED LIMIT $2`
	}
	rows, err := s.db.QueryContext(ctx, query, before.UnixMilli(), limit)
	if err != nil {
		return 0, err
	}
	var taskIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		taskIDs = append(taskIDs, id)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	marked := 0
	for _, taskID := range taskIDs {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return marked, err
		}
		var jobID, stepName string
		lookup := "SELECT job_id, step_name FROM task_outbox WHERE task_id=? AND state='delivered'"
		if s.dialect == Postgres {
			lookup = "SELECT job_id, step_name FROM task_outbox WHERE task_id=$1 AND state='delivered' FOR UPDATE"
		}
		if err := tx.QueryRowContext(ctx, lookup, taskID).Scan(&jobID, &stepName); err != nil {
			tx.Rollback()
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			return marked, err
		}
		now := s.now().UnixMilli()
		queries := []string{
			"UPDATE task_outbox SET state='orphaned' WHERE task_id=? AND state='delivered'",
			"UPDATE job_steps SET state='orphaned', updated_at_ms=? WHERE job_id=? AND name=? AND state='running'",
			"UPDATE jobs SET state='orphaned', updated_at_ms=? WHERE id=? AND state='running'",
			"INSERT INTO job_events(job_id, step_name, event_type, payload_json, created_at_ms) VALUES(?, ?, 'task_orphaned', '{}', ?)",
		}
		args := [][]any{{taskID}, {now, jobID, stepName}, {now, jobID}, {jobID, stepName, now}}
		if s.dialect == Postgres {
			queries = []string{
				"UPDATE task_outbox SET state='orphaned' WHERE task_id=$1 AND state='delivered'",
				"UPDATE job_steps SET state='orphaned', updated_at_ms=$1 WHERE job_id=$2 AND name=$3 AND state='running'",
				"UPDATE jobs SET state='orphaned', updated_at_ms=$1 WHERE id=$2 AND state='running'",
				"INSERT INTO job_events(job_id, step_name, event_type, payload_json, created_at_ms) VALUES($1, $2, 'task_orphaned', '{}'::jsonb, $3)",
			}
		}
		for index := range queries {
			if _, err := tx.ExecContext(ctx, queries[index], args[index]...); err != nil {
				tx.Rollback()
				return marked, err
			}
		}
		if err := tx.Commit(); err != nil {
			return marked, err
		}
		marked++
	}
	return marked, nil
}
