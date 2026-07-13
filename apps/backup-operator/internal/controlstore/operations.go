package controlstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
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

// DestructiveFencingDomain returns the single fencing sequence consumed by
// every destructive task sent to one enrolled Agent recovery domain. Business
// operation leases remain independent from this monotonic counter.
func DestructiveFencingDomain(clusterID, nodeID string) (string, error) {
	if strings.TrimSpace(clusterID) == "" || strings.TrimSpace(nodeID) == "" || strings.ContainsAny(clusterID+nodeID, "\r\n") {
		return "", errors.New("destructive fencing cluster and node are required")
	}
	return "agent/" + clusterID + "/" + nodeID, nil
}

type Enrollment struct {
	AgentID                string
	ClusterID              string
	NodeID                 string
	CertificateFingerprint string
	Capabilities           []string
	Revoked                bool
}

func (s *Store) EnrollAgent(ctx context.Context, enrollment Enrollment) error {
	if enrollment.AgentID == "" || enrollment.ClusterID == "" || enrollment.NodeID == "" || enrollment.CertificateFingerprint == "" || len(enrollment.Capabilities) == 0 {
		return errors.New("complete cluster, node, Agent, certificate, and capability enrollment is required")
	}
	capabilities, err := json.Marshal(enrollment.Capabilities)
	if err != nil {
		return err
	}
	now := s.now().UnixMilli()
	query := `INSERT INTO agent_enrollments(agent_id, cluster_id, node_id, certificate_fingerprint, capabilities_json, created_at_ms, updated_at_ms)
VALUES(?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(agent_id) DO UPDATE SET cluster_id=excluded.cluster_id, certificate_fingerprint=excluded.certificate_fingerprint, capabilities_json=excluded.capabilities_json, updated_at_ms=excluded.updated_at_ms
WHERE (agent_enrollments.cluster_id='' OR agent_enrollments.cluster_id=excluded.cluster_id) AND agent_enrollments.node_id=excluded.node_id`
	if s.dialect == Postgres {
		query = `INSERT INTO agent_enrollments(agent_id, cluster_id, node_id, certificate_fingerprint, capabilities_json, created_at_ms, updated_at_ms)
VALUES($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT(agent_id) DO UPDATE SET cluster_id=excluded.cluster_id, certificate_fingerprint=excluded.certificate_fingerprint, capabilities_json=excluded.capabilities_json, updated_at_ms=excluded.updated_at_ms
WHERE (agent_enrollments.cluster_id='' OR agent_enrollments.cluster_id=excluded.cluster_id) AND agent_enrollments.node_id=excluded.node_id`
	}
	result, err := s.db.ExecContext(ctx, query, enrollment.AgentID, enrollment.ClusterID, enrollment.NodeID, enrollment.CertificateFingerprint, string(capabilities), now, now)
	if err != nil {
		return err
	}
	if rows, _ := result.RowsAffected(); rows != 1 {
		return errors.New("Agent enrollment cannot change its cluster or node binding")
	}
	return nil
}

func (s *Store) GetAgentEnrollment(ctx context.Context, agentID string) (Enrollment, error) {
	query := "SELECT agent_id,cluster_id,node_id,certificate_fingerprint,capabilities_json,revoked_at_ms IS NOT NULL FROM agent_enrollments WHERE agent_id=?"
	if s.dialect == Postgres {
		query = "SELECT agent_id,cluster_id,node_id,certificate_fingerprint,capabilities_json::text,revoked_at_ms IS NOT NULL FROM agent_enrollments WHERE agent_id=$1"
	}
	var enrollment Enrollment
	var capabilities string
	if err := s.db.QueryRowContext(ctx, query, agentID).Scan(&enrollment.AgentID, &enrollment.ClusterID, &enrollment.NodeID, &enrollment.CertificateFingerprint, &capabilities, &enrollment.Revoked); err != nil {
		return Enrollment{}, err
	}
	if err := json.Unmarshal([]byte(capabilities), &enrollment.Capabilities); err != nil {
		return Enrollment{}, err
	}
	return enrollment, nil
}

type RestorePlanRecord struct {
	ID              string
	JobID           string
	PlanHash        string
	SafetyInputJSON string
	ExpiresAt       time.Time
}

var ErrRestorePlanNotFound = errors.New("restore plan not found")

func (s *Store) GetRestorePlan(ctx context.Context, planID string) (RestorePlanRecord, error) {
	query := `SELECT id,job_id,plan_hash,safety_input_json,expires_at_ms FROM restore_plans WHERE id=?`
	if s.dialect == Postgres {
		query = `SELECT id,job_id,plan_hash,safety_input_json::text,expires_at_ms FROM restore_plans WHERE id=$1`
	}
	var plan RestorePlanRecord
	var expiresAt int64
	if err := s.db.QueryRowContext(ctx, query, planID).Scan(&plan.ID, &plan.JobID, &plan.PlanHash, &plan.SafetyInputJSON, &expiresAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return plan, ErrRestorePlanNotFound
		}
		return plan, err
	}
	plan.ExpiresAt = time.UnixMilli(expiresAt).UTC()
	return plan, nil
}

func (s *Store) SaveRestorePlan(ctx context.Context, plan RestorePlanRecord) error {
	if plan.ID == "" || plan.JobID == "" || plan.PlanHash == "" || !json.Valid([]byte(plan.SafetyInputJSON)) || !s.now().Before(plan.ExpiresAt) {
		return errors.New("valid restore plan identity, safety inputs, and future expiry are required")
	}
	var safety restoreplan.SafetyInputs
	if err := json.Unmarshal([]byte(plan.SafetyInputJSON), &safety); err != nil {
		return errors.New("restore plan safety inputs are invalid")
	}
	if safety.Target.ProjectID == "" || safety.Target.TargetID == "" {
		existing, err := s.GetJob(ctx, plan.JobID)
		if err != nil {
			return errors.New("restore plan target safety identity is required")
		}
		safety.Target = contracts.TargetRef{ProjectID: existing.ProjectID, TargetID: existing.TargetID}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := s.now().UnixMilli()
	jobQuery := `INSERT INTO jobs(id,project_id,target_id,type,state,idempotency_key,plan_hash,input_json,created_at_ms,updated_at_ms) VALUES(?,?,?,'restore','planned',?,?,?, ?, ?) ON CONFLICT(id) DO NOTHING`
	if s.dialect == Postgres {
		jobQuery = `INSERT INTO jobs(id,project_id,target_id,type,state,idempotency_key,plan_hash,input_json,created_at_ms,updated_at_ms) VALUES($1,$2,$3,'restore','planned',$4,$5,$6::jsonb,$7,$8) ON CONFLICT(id) DO NOTHING`
	}
	if _, err := tx.ExecContext(ctx, jobQuery, plan.JobID, safety.Target.ProjectID, safety.Target.TargetID, "restore/"+plan.ID, plan.PlanHash, plan.SafetyInputJSON, now, now); err != nil {
		return err
	}
	query := `INSERT INTO restore_plans(id, job_id, plan_hash, safety_input_json, expires_at_ms, created_at_ms)
VALUES(?, ?, ?, ?, ?, ?)`
	if s.dialect == Postgres {
		query = `INSERT INTO restore_plans(id, job_id, plan_hash, safety_input_json, expires_at_ms, created_at_ms)
VALUES($1, $2, $3, $4, $5, $6)`
	}
	if _, err = tx.ExecContext(ctx, query, plan.ID, plan.JobID, plan.PlanHash, plan.SafetyInputJSON, plan.ExpiresAt.UnixMilli(), now); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) DispatchConfirmedRestore(ctx context.Context, plan ConfirmedRestorePlan) (JobRecord, error) {
	job, err := s.GetJob(ctx, plan.JobID)
	if err != nil {
		return JobRecord{}, err
	}
	// A confirmed plan owns one durable restore job. Replaying the execute
	// mutation returns that job instead of acquiring a new lease or emitting a
	// second outbox task after the first dispatch crossed the durable boundary.
	if job.State != "planned" {
		return job, nil
	}
	nowTime := s.now()
	if !nowTime.Before(plan.ExpiresAt) {
		return JobRecord{}, errors.New("restore dispatch deadline has expired")
	}
	// The evidence deadline governs authorization and dispatch. Once the task is
	// durably accepted, providers need an independent bounded execution window;
	// real PVC provisioning and PITR routinely take longer than a 30-second
	// topology observation TTL.
	const executionTTL = 15 * time.Minute
	executionPlan := plan
	executionPlan.ExpiresAt = nowTime.Add(executionTTL)
	capability, payload, err := providerRestoreTask(executionPlan, "execute")
	if err != nil {
		return JobRecord{}, err
	}
	var safety restoreplan.SafetyInputs
	if err := json.Unmarshal([]byte(plan.SafetyInputJSON), &safety); err != nil || safety.TargetNodeID == "" {
		return JobRecord{}, errors.New("confirmed restore plan has no routable target node")
	}
	_, acquired, err := s.AcquireLease(ctx, "destructive/"+job.TargetID, plan.JobID, executionTTL)
	if err != nil || !acquired {
		return JobRecord{}, fmt.Errorf("acquire destructive fencing lease: acquired=%v: %w", acquired, err)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return JobRecord{}, err
	}
	defer tx.Rollback()
	now := s.now().UnixMilli()
	step := "INSERT INTO job_steps(job_id,name,state,fencing_token,non_takeover,updated_at_ms) VALUES(?, 'execute','queued',?,1,?)"
	outbox := "INSERT INTO task_outbox(task_id,job_id,step_name,capability,target_node_id,idempotency_key,payload,created_at_ms) VALUES(?,?,'execute',?,?,?, ?,?)"
	update := "UPDATE jobs SET state='queued',updated_at_ms=? WHERE id=? AND state='planned'"
	if s.dialect == Postgres {
		step = "INSERT INTO job_steps(job_id,name,state,fencing_token,non_takeover,updated_at_ms) VALUES($1,'execute','queued',$2,1,$3)"
		outbox = "INSERT INTO task_outbox(task_id,job_id,step_name,capability,target_node_id,idempotency_key,payload,created_at_ms) VALUES($1,$2,'execute',$3,$4,$5,$6,$7)"
		update = "UPDATE jobs SET state='queued',updated_at_ms=$1 WHERE id=$2 AND state='planned'"
	}
	result, err := tx.ExecContext(ctx, update, now, plan.JobID)
	if err != nil {
		return JobRecord{}, err
	}
	rows, _ := result.RowsAffected()
	if rows != 1 {
		return JobRecord{}, errors.New("restore job is not dispatchable")
	}
	taskID := plan.JobID + "/execute"
	fencingToken, err := s.allocateTaskFencingToken(ctx, tx, taskID, job.TargetID, safety.TargetNodeID)
	if err != nil {
		return JobRecord{}, err
	}
	if _, err = tx.ExecContext(ctx, step, plan.JobID, fencingToken, now); err != nil {
		return JobRecord{}, err
	}
	if _, err = tx.ExecContext(ctx, outbox, taskID, plan.JobID, capability, safety.TargetNodeID, "restore/"+plan.ID+"/execute", payload, now); err != nil {
		return JobRecord{}, err
	}
	if err = tx.Commit(); err != nil {
		return JobRecord{}, err
	}
	return s.GetJob(ctx, plan.JobID)
}

type restoreTaskEnvelope struct {
	Action       string                   `json:"action"`
	PlanID       string                   `json:"planId"`
	PlanHash     string                   `json:"planHash"`
	ExpiresAt    time.Time                `json:"expiresAt"`
	SafetyInputs restoreplan.SafetyInputs `json:"safetyInputs"`
}

func providerRestoreTask(plan ConfirmedRestorePlan, action string) (string, []byte, error) {
	var safety restoreplan.SafetyInputs
	if err := json.Unmarshal([]byte(plan.SafetyInputJSON), &safety); err != nil {
		return "", nil, fmt.Errorf("decode confirmed restore safety inputs: %w", err)
	}
	provider := safety.TopologyProvider
	switch provider {
	case "single-primary-pgbackrest", "patroni-pgbackrest", "custom-postgres-kubernetes", "cloudnativepg-cnpg-i":
	default:
		return "", nil, fmt.Errorf("restore topology provider %q has no executable strategy", provider)
	}
	if action != "execute" && action != "rollback" {
		return "", nil, fmt.Errorf("unsupported restore action %q", action)
	}
	payload, err := json.Marshal(restoreTaskEnvelope{Action: action, PlanID: plan.ID, PlanHash: plan.PlanHash, ExpiresAt: plan.ExpiresAt, SafetyInputs: safety})
	if err != nil {
		return "", nil, err
	}
	return provider + ".restore." + action, payload, nil
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
	TaskID         string
	JobID          string
	ProjectID      string
	TargetID       string
	ClusterID      string
	StepName       string
	Capability     string
	NodeID         string
	IdempotencyKey string
	FencingToken   int64
	Payload        []byte
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

func (s *Store) HasArchivedEventsAfter(ctx context.Context, jobID string, cursor int64) (bool, error) {
	query := "SELECT EXISTS(SELECT 1 FROM job_event_archive WHERE job_id=? AND id>? LIMIT 1)"
	if s.dialect == Postgres {
		query = "SELECT EXISTS(SELECT 1 FROM job_event_archive WHERE job_id=$1 AND id>$2 LIMIT 1)"
	}
	var exists bool
	err := s.db.QueryRowContext(ctx, query, jobID, cursor).Scan(&exists)
	return exists, err
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
	query := `SELECT o.task_id, o.job_id, j.project_id, j.target_id, o.step_name, o.capability, o.target_node_id, o.idempotency_key, s.fencing_token, o.payload
FROM task_outbox o JOIN jobs j ON j.id=o.job_id JOIN job_steps s ON s.job_id=o.job_id AND s.name=o.step_name
	WHERE o.state='pending' AND (o.claim_until_ms IS NULL OR o.claim_until_ms < ?)
	ORDER BY o.created_at_ms LIMIT ?`
	args := []any{now, limit}
	if s.dialect == Postgres {
		query = `SELECT o.task_id, o.job_id, j.project_id, j.target_id, o.step_name, o.capability, o.target_node_id, o.idempotency_key, s.fencing_token, o.payload
FROM task_outbox o JOIN jobs j ON j.id=o.job_id JOIN job_steps s ON s.job_id=o.job_id AND s.name=o.step_name
WHERE o.state='pending' AND (o.claim_until_ms IS NULL OR o.claim_until_ms < $1)
ORDER BY o.created_at_ms FOR UPDATE OF o SKIP LOCKED LIMIT $2`
	}
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	var tasks []OutboxTask
	for rows.Next() {
		var task OutboxTask
		if err := rows.Scan(&task.TaskID, &task.JobID, &task.ProjectID, &task.TargetID, &task.StepName, &task.Capability, &task.NodeID, &task.IdempotencyKey, &task.FencingToken, &task.Payload); err != nil {
			rows.Close()
			return nil, err
		}
		task.ClusterID = task.TargetID
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
