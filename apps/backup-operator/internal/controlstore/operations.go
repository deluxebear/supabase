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

var (
	ErrRestorePlanNotConfirmable = errors.New("restore plan is missing, stale, expired, or already confirmed")
	ErrRestorePlanNotConfirmed   = errors.New("restore plan does not have a fresh confirmation")
)

type Lease struct {
	ResourceKey  string
	OwnerID      string
	FencingToken int64
	ExpiresAt    time.Time
}

func (s *Store) AcquireLease(ctx context.Context, resourceKey, ownerID string, ttl time.Duration) (Lease, bool, error) {
	now := s.now()
	expires := now.Add(ttl)
	query := `INSERT INTO leases(resource_key, owner_id, fencing_token, expires_at_ms, updated_at_ms)
VALUES(?, ?, 1, ?, ?)
ON CONFLICT(resource_key) DO UPDATE SET
  owner_id=excluded.owner_id,
  fencing_token=CASE WHEN leases.owner_id=excluded.owner_id THEN leases.fencing_token ELSE leases.fencing_token+1 END,
  expires_at_ms=excluded.expires_at_ms,
  updated_at_ms=excluded.updated_at_ms
WHERE leases.expires_at_ms < ? OR leases.owner_id=excluded.owner_id
RETURNING fencing_token`
	args := []any{resourceKey, ownerID, expires.UnixMilli(), now.UnixMilli(), now.UnixMilli()}
	if s.dialect == Postgres {
		query = `INSERT INTO leases(resource_key, owner_id, fencing_token, expires_at_ms, updated_at_ms)
VALUES($1, $2, 1, $3, $4)
ON CONFLICT(resource_key) DO UPDATE SET
  owner_id=excluded.owner_id,
  fencing_token=CASE WHEN leases.owner_id=excluded.owner_id THEN leases.fencing_token ELSE leases.fencing_token+1 END,
  expires_at_ms=excluded.expires_at_ms,
  updated_at_ms=excluded.updated_at_ms
WHERE leases.expires_at_ms < $5 OR leases.owner_id=excluded.owner_id
RETURNING fencing_token`
	}
	var token int64
	if err := s.db.QueryRowContext(ctx, query, args...).Scan(&token); err != nil {
		if err == sql.ErrNoRows {
			return Lease{}, false, nil
		}
		return Lease{}, false, err
	}
	return Lease{ResourceKey: resourceKey, OwnerID: ownerID, FencingToken: token, ExpiresAt: expires}, true, nil
}

type Enrollment struct {
	AgentID                string
	NodeID                 string
	CertificateFingerprint string
	Capabilities           []string
}

func (s *Store) EnrollAgent(ctx context.Context, enrollment Enrollment) error {
	capabilities, err := json.Marshal(enrollment.Capabilities)
	if err != nil {
		return err
	}
	now := s.now().UnixMilli()
	query := `INSERT INTO agent_enrollments(agent_id, node_id, certificate_fingerprint, capabilities_json, created_at_ms, updated_at_ms)
VALUES(?, ?, ?, ?, ?, ?)
ON CONFLICT(agent_id) DO UPDATE SET node_id=excluded.node_id, certificate_fingerprint=excluded.certificate_fingerprint, capabilities_json=excluded.capabilities_json, updated_at_ms=excluded.updated_at_ms`
	if s.dialect == Postgres {
		query = `INSERT INTO agent_enrollments(agent_id, node_id, certificate_fingerprint, capabilities_json, created_at_ms, updated_at_ms)
VALUES($1, $2, $3, $4, $5, $6)
ON CONFLICT(agent_id) DO UPDATE SET node_id=excluded.node_id, certificate_fingerprint=excluded.certificate_fingerprint, capabilities_json=excluded.capabilities_json, updated_at_ms=excluded.updated_at_ms`
	}
	_, err = s.db.ExecContext(ctx, query, enrollment.AgentID, enrollment.NodeID, enrollment.CertificateFingerprint, string(capabilities), now, now)
	return err
}

type RestorePlanRecord struct {
	ID              string
	JobID           string
	PlanHash        string
	SafetyInputJSON string
	ExpiresAt       time.Time
}

func (s *Store) SaveRestorePlan(ctx context.Context, plan RestorePlanRecord) error {
	if plan.ID == "" || plan.JobID == "" || plan.PlanHash == "" || !json.Valid([]byte(plan.SafetyInputJSON)) || !s.now().Before(plan.ExpiresAt) {
		return errors.New("valid restore plan identity, safety inputs, and future expiry are required")
	}
	query := `INSERT INTO restore_plans(id, job_id, plan_hash, safety_input_json, expires_at_ms, created_at_ms)
VALUES(?, ?, ?, ?, ?, ?)`
	if s.dialect == Postgres {
		query = `INSERT INTO restore_plans(id, job_id, plan_hash, safety_input_json, expires_at_ms, created_at_ms)
VALUES($1, $2, $3, $4, $5, $6)`
	}
	_, err := s.db.ExecContext(ctx, query, plan.ID, plan.JobID, plan.PlanHash, plan.SafetyInputJSON, plan.ExpiresAt.UnixMilli(), s.now().UnixMilli())
	return err
}

type ConfirmedRestorePlan struct {
	ID              string
	JobID           string
	PlanHash        string
	SafetyInputJSON string
	Subject         string
	ConfirmedAt     time.Time
	ExpiresAt       time.Time
}

func (s *Store) ConfirmRestorePlan(ctx context.Context, planID, planHash string, assertion restoreplan.AAL2Assertion, maxAAL2Age time.Duration) error {
	now := s.now()
	if err := restoreplan.ValidateAAL2(assertion, now, maxAAL2Age); err != nil {
		return err
	}
	query := `UPDATE restore_plans SET aal2_subject=?, confirmed_at_ms=?
WHERE id=? AND plan_hash=? AND expires_at_ms>? AND confirmed_at_ms IS NULL`
	if s.dialect == Postgres {
		query = `UPDATE restore_plans SET aal2_subject=$1, confirmed_at_ms=$2
WHERE id=$3 AND plan_hash=$4 AND expires_at_ms>$5 AND confirmed_at_ms IS NULL`
	}
	result, err := s.db.ExecContext(ctx, query, assertion.Subject, now.UnixMilli(), planID, planHash, now.UnixMilli())
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows != 1 {
		return ErrRestorePlanNotConfirmable
	}
	return nil
}

func (s *Store) RequireConfirmedRestorePlan(ctx context.Context, planID, planHash string, confirmationTTL time.Duration) (ConfirmedRestorePlan, error) {
	if confirmationTTL <= 0 {
		return ConfirmedRestorePlan{}, ErrRestorePlanNotConfirmed
	}
	query := `SELECT id, job_id, plan_hash, safety_input_json, aal2_subject, confirmed_at_ms, expires_at_ms
FROM restore_plans WHERE id=? AND plan_hash=?`
	if s.dialect == Postgres {
		query = `SELECT id, job_id, plan_hash, safety_input_json::text, aal2_subject, confirmed_at_ms, expires_at_ms
FROM restore_plans WHERE id=$1 AND plan_hash=$2`
	}
	var plan ConfirmedRestorePlan
	var confirmedAt, expiresAt sql.NullInt64
	err := s.db.QueryRowContext(ctx, query, planID, planHash).Scan(
		&plan.ID, &plan.JobID, &plan.PlanHash, &plan.SafetyInputJSON, &plan.Subject, &confirmedAt, &expiresAt,
	)
	if err != nil || !confirmedAt.Valid || !expiresAt.Valid {
		return ConfirmedRestorePlan{}, ErrRestorePlanNotConfirmed
	}
	plan.ConfirmedAt = time.UnixMilli(confirmedAt.Int64)
	plan.ExpiresAt = time.UnixMilli(expiresAt.Int64)
	now := s.now()
	if plan.Subject == "" || !now.Before(plan.ExpiresAt) || now.Sub(plan.ConfirmedAt) > confirmationTTL || plan.ConfirmedAt.After(now) {
		return ConfirmedRestorePlan{}, ErrRestorePlanNotConfirmed
	}
	return plan, nil
}

func (s *Store) AppendAudit(ctx context.Context, actor, action, target, payloadJSON string) error {
	query := "INSERT INTO audit_events(actor, action, target, payload_json, created_at_ms) VALUES(?, ?, ?, ?, ?)"
	if s.dialect == Postgres {
		query = "INSERT INTO audit_events(actor, action, target, payload_json, created_at_ms) VALUES($1, $2, $3, $4, $5)"
	}
	_, err := s.db.ExecContext(ctx, query, actor, action, target, payloadJSON, s.now().UnixMilli())
	return err
}

type OutboxTask struct {
	TaskID     string
	JobID      string
	Capability string
	NodeID     string
}

type JobEvent struct {
	Cursor    int64
	JobID     string
	StepName  sql.NullString
	EventType string
	Payload   string
	CreatedAt time.Time
}

func (s *Store) EventsAfter(ctx context.Context, jobID string, cursor int64, limit int) ([]JobEvent, error) {
	if limit < 1 || limit > 1000 {
		return nil, fmt.Errorf("event limit must be between 1 and 1000")
	}
	query := "SELECT id, job_id, step_name, event_type, payload_json, created_at_ms FROM job_events WHERE job_id=? AND id>? ORDER BY id LIMIT ?"
	if s.dialect == Postgres {
		query = "SELECT id, job_id, step_name, event_type, payload_json::text, created_at_ms FROM job_events WHERE job_id=$1 AND id>$2 ORDER BY id LIMIT $3"
	}
	rows, err := s.db.QueryContext(ctx, query, jobID, cursor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []JobEvent
	for rows.Next() {
		var event JobEvent
		var createdAt int64
		if err := rows.Scan(&event.Cursor, &event.JobID, &event.StepName, &event.EventType, &event.Payload, &createdAt); err != nil {
			return nil, err
		}
		event.CreatedAt = time.UnixMilli(createdAt)
		events = append(events, event)
	}
	return events, rows.Err()
}

func (s *Store) ClaimOutbox(ctx context.Context, owner string, limit int, ttl time.Duration) ([]OutboxTask, error) {
	if limit < 1 || limit > 100 {
		return nil, fmt.Errorf("claim limit must be between 1 and 100")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	now := s.now().UnixMilli()
	query := `SELECT task_id, job_id, capability, target_node_id FROM task_outbox
WHERE state='pending' AND (claim_until_ms IS NULL OR claim_until_ms < ?)
ORDER BY created_at_ms LIMIT ?`
	args := []any{now, limit}
	if s.dialect == Postgres {
		query = `SELECT task_id, job_id, capability, target_node_id FROM task_outbox
WHERE state='pending' AND (claim_until_ms IS NULL OR claim_until_ms < $1)
ORDER BY created_at_ms FOR UPDATE SKIP LOCKED LIMIT $2`
	}
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	var tasks []OutboxTask
	for rows.Next() {
		var task OutboxTask
		if err := rows.Scan(&task.TaskID, &task.JobID, &task.Capability, &task.NodeID); err != nil {
			rows.Close()
			return nil, err
		}
		tasks = append(tasks, task)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	update := "UPDATE task_outbox SET claim_owner=?, claim_until_ms=? WHERE task_id=? AND state='pending'"
	if s.dialect == Postgres {
		update = "UPDATE task_outbox SET claim_owner=$1, claim_until_ms=$2 WHERE task_id=$3 AND state='pending'"
	}
	for _, task := range tasks {
		if _, err := tx.ExecContext(ctx, update, owner, s.now().Add(ttl).UnixMilli(), task.TaskID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return tasks, nil
}

func (s *Store) PruneEvents(ctx context.Context, before time.Time) (jobEvents, auditEvents int64, err error) {
	jobQuery := "DELETE FROM job_events WHERE created_at_ms < ?"
	auditQuery := "DELETE FROM audit_events WHERE created_at_ms < ?"
	if s.dialect == Postgres {
		jobQuery = "DELETE FROM job_events WHERE created_at_ms < $1"
		auditQuery = "DELETE FROM audit_events WHERE created_at_ms < $1"
	}
	result, err := s.db.ExecContext(ctx, jobQuery, before.UnixMilli())
	if err != nil {
		return 0, 0, err
	}
	jobEvents, err = result.RowsAffected()
	if err != nil {
		return 0, 0, err
	}
	result, err = s.db.ExecContext(ctx, auditQuery, before.UnixMilli())
	if err != nil {
		return 0, 0, err
	}
	auditEvents, err = result.RowsAffected()
	return
}
