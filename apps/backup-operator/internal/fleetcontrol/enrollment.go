package fleetcontrol

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	ErrEnrollmentNotFound = errors.New("enrollment token not found")
	ErrEnrollmentReplay   = errors.New("enrollment token already consumed")
	ErrEnrollmentExpired  = errors.New("enrollment token expired")
	ErrEnrollmentBinding  = errors.New("enrollment token binding mismatch")
	ErrAgentNotFound      = errors.New("Agent not found")
	ErrCertificateRevoked = errors.New("Agent certificate revoked")
	ErrProtocolMismatch   = errors.New("Agent protocol is incompatible")
)

type ManagementBinding struct {
	BindingID                 string    `json:"bindingId"`
	OrganizationID            string    `json:"organizationId"`
	ProjectRef                string    `json:"projectRef"`
	TargetID                  string    `json:"targetId"`
	ExecutionTarget           string    `json:"executionTarget"`
	DeploymentKind            string    `json:"deploymentKind"`
	AllowedCapabilityPrefixes []string  `json:"allowedCapabilityPrefixes"`
	State                     string    `json:"state"`
	CreatedAt                 time.Time `json:"createdAt"`
	UpdatedAt                 time.Time `json:"updatedAt"`
}

type CapabilityObservation struct {
	Domain          string    `json:"domain"`
	Name            string    `json:"name"`
	ContractVersion string    `json:"contractVersion"`
	InputSchema     string    `json:"inputSchema"`
	EvidenceSchema  string    `json:"evidenceSchema"`
	ObservedAt      time.Time `json:"observedAt"`
	ValidUntil      time.Time `json:"validUntil"`
}

type AgentRecord struct {
	ID                        string                  `json:"id"`
	BindingID                 string                  `json:"bindingId"`
	State                     string                  `json:"state"`
	ProtocolMajor             int                     `json:"protocolMajor"`
	ProtocolMinor             int                     `json:"protocolMinor"`
	Build                     string                  `json:"build"`
	ActiveCertificateRevision int                     `json:"activeCertificateRevision"`
	CertificateExpiresAt      time.Time               `json:"certificateExpiresAt"`
	LastSeenAt                time.Time               `json:"lastSeenAt"`
	LeaseExpiresAt            time.Time               `json:"leaseExpiresAt"`
	UnavailableAt             time.Time               `json:"unavailableAt"`
	SessionState              string                  `json:"sessionState"`
	Capabilities              []CapabilityObservation `json:"capabilities"`
}

type BindingStatus struct {
	Binding ManagementBinding `json:"binding"`
	Agent   *AgentRecord      `json:"agent"`
}

type CreateEnrollmentTokenInput struct {
	Binding       ManagementBinding
	TokenID       string
	TokenHash     string
	ExpiresAt     time.Time
	Actor         string
	CorrelationID string
}

type EnrollAgentInput struct {
	TokenHash        string
	Binding          ManagementBinding
	AgentID          string
	ProtocolMajor    int
	ProtocolMinor    int
	Build            string
	ObservedIdentity json.RawMessage
	Capabilities     []CapabilityObservation
	Certificate      IssuedCertificate
}

func (s *Store) CreateEnrollmentToken(ctx context.Context, input CreateEnrollmentTokenInput) error {
	if input.Binding.BindingID == "" || input.Binding.OrganizationID == "" || input.Binding.ProjectRef == "" || input.Binding.TargetID == "" || input.Binding.ExecutionTarget == "" || input.Binding.DeploymentKind == "" || len(input.Binding.AllowedCapabilityPrefixes) == 0 || input.TokenID == "" || len(input.TokenHash) != 64 || input.Actor == "" || input.CorrelationID == "" || !input.ExpiresAt.After(s.now()) {
		return errors.New("complete enrollment token binding and audit identity is required")
	}
	prefixes, err := json.Marshal(input.Binding.AllowedCapabilityPrefixes)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := s.now().UTC().UnixMilli()
	var existingOrganization, existingProject, existingTarget, existingExecution, existingKind string
	queryExisting := "SELECT organization_id,project_ref,target_id,execution_target,deployment_kind FROM management_bindings WHERE binding_id=?"
	if s.dialect == FleetPostgres {
		queryExisting = "SELECT organization_id,project_ref,target_id,execution_target,deployment_kind FROM management_bindings WHERE binding_id=$1 FOR UPDATE"
	}
	err = tx.QueryRowContext(ctx, queryExisting, input.Binding.BindingID).Scan(&existingOrganization, &existingProject, &existingTarget, &existingExecution, &existingKind)
	if err == nil && (existingOrganization != input.Binding.OrganizationID || existingProject != input.Binding.ProjectRef || existingTarget != input.Binding.TargetID || existingExecution != input.Binding.ExecutionTarget || existingKind != input.Binding.DeploymentKind) {
		return ErrEnrollmentBinding
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	upsert := `INSERT INTO management_bindings(binding_id,organization_id,project_ref,target_id,execution_target,deployment_kind,allowed_capability_prefixes_json,state,created_at_ms,updated_at_ms)
VALUES(?,?,?,?,?,?,?,'enrolling',?,?) ON CONFLICT(binding_id) DO UPDATE SET allowed_capability_prefixes_json=excluded.allowed_capability_prefixes_json,state=CASE WHEN management_bindings.state='active' THEN 'active' ELSE 'enrolling' END,updated_at_ms=excluded.updated_at_ms`
	if s.dialect == FleetPostgres {
		upsert = `INSERT INTO management_bindings(binding_id,organization_id,project_ref,target_id,execution_target,deployment_kind,allowed_capability_prefixes_json,state,created_at_ms,updated_at_ms)
VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'enrolling',$8,$9) ON CONFLICT(binding_id) DO UPDATE SET allowed_capability_prefixes_json=excluded.allowed_capability_prefixes_json,state=CASE WHEN management_bindings.state='active' THEN 'active' ELSE 'enrolling' END,updated_at_ms=excluded.updated_at_ms`
	}
	if _, err := tx.ExecContext(ctx, upsert, input.Binding.BindingID, input.Binding.OrganizationID, input.Binding.ProjectRef, input.Binding.TargetID, input.Binding.ExecutionTarget, input.Binding.DeploymentKind, string(prefixes), now, now); err != nil {
		return err
	}
	revoke := "UPDATE enrollment_tokens SET revoked_at_ms=? WHERE binding_id=? AND consumed_at_ms IS NULL AND revoked_at_ms IS NULL"
	if s.dialect == FleetPostgres {
		revoke = "UPDATE enrollment_tokens SET revoked_at_ms=$1 WHERE binding_id=$2 AND consumed_at_ms IS NULL AND revoked_at_ms IS NULL"
	}
	if _, err := tx.ExecContext(ctx, revoke, now, input.Binding.BindingID); err != nil {
		return err
	}
	insert := "INSERT INTO enrollment_tokens(id,token_hash,binding_id,expires_at_ms,created_by,correlation_id,created_at_ms) VALUES(?,?,?,?,?,?,?)"
	if s.dialect == FleetPostgres {
		insert = "INSERT INTO enrollment_tokens(id,token_hash,binding_id,expires_at_ms,created_by,correlation_id,created_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7)"
	}
	if _, err := tx.ExecContext(ctx, insert, input.TokenID, input.TokenHash, input.Binding.BindingID, input.ExpiresAt.UTC().UnixMilli(), input.Actor, input.CorrelationID, now); err != nil {
		return err
	}
	if err := insertFleetAudit(ctx, tx, s.dialect, input.Actor, input.Binding.ProjectRef, "fleet.enrollment_token.create", input.Binding.TargetID, input.TokenID, input.CorrelationID, now); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) EnrollAgent(ctx context.Context, input EnrollAgentInput) (AgentRecord, error) {
	if input.TokenHash == "" || input.AgentID == "" || input.Certificate.Serial == "" || input.Certificate.Fingerprint == "" || len(input.Capabilities) == 0 {
		return AgentRecord{}, errors.New("complete Agent enrollment evidence is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AgentRecord{}, err
	}
	defer tx.Rollback()
	query := `SELECT t.expires_at_ms,t.consumed_at_ms,t.revoked_at_ms,t.created_by,t.correlation_id,
b.binding_id,b.organization_id,b.project_ref,b.target_id,b.execution_target,b.deployment_kind,b.allowed_capability_prefixes_json
FROM enrollment_tokens t JOIN management_bindings b ON b.binding_id=t.binding_id WHERE t.token_hash=?`
	if s.dialect == FleetPostgres {
		query = `SELECT t.expires_at_ms,t.consumed_at_ms,t.revoked_at_ms,t.created_by,t.correlation_id,
b.binding_id,b.organization_id,b.project_ref,b.target_id,b.execution_target,b.deployment_kind,b.allowed_capability_prefixes_json
FROM enrollment_tokens t JOIN management_bindings b ON b.binding_id=t.binding_id WHERE t.token_hash=$1 FOR UPDATE`
	}
	var expiresAt int64
	var consumedAt, revokedAt sql.NullInt64
	var actor, correlationID string
	var stored ManagementBinding
	var prefixesJSON []byte
	err = tx.QueryRowContext(ctx, query, input.TokenHash).Scan(&expiresAt, &consumedAt, &revokedAt, &actor, &correlationID, &stored.BindingID, &stored.OrganizationID, &stored.ProjectRef, &stored.TargetID, &stored.ExecutionTarget, &stored.DeploymentKind, &prefixesJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return AgentRecord{}, ErrEnrollmentNotFound
	}
	if err != nil {
		return AgentRecord{}, err
	}
	if consumedAt.Valid {
		return AgentRecord{}, ErrEnrollmentReplay
	}
	if revokedAt.Valid {
		return AgentRecord{}, ErrCertificateRevoked
	}
	now := s.now().UTC()
	if now.UnixMilli() > expiresAt {
		return AgentRecord{}, ErrEnrollmentExpired
	}
	if err := json.Unmarshal(prefixesJSON, &stored.AllowedCapabilityPrefixes); err != nil {
		return AgentRecord{}, err
	}
	if !sameBinding(stored, input.Binding) {
		return AgentRecord{}, ErrEnrollmentBinding
	}
	if err := validateCapabilityObservations(input.Capabilities, stored.AllowedCapabilityPrefixes); err != nil {
		return AgentRecord{}, err
	}
	if input.ProtocolMajor != 1 || input.ProtocolMinor < 0 || input.ProtocolMinor > 0 {
		return AgentRecord{}, ErrProtocolMismatch
	}
	consume := "UPDATE enrollment_tokens SET consumed_at_ms=? WHERE token_hash=? AND consumed_at_ms IS NULL AND revoked_at_ms IS NULL"
	if s.dialect == FleetPostgres {
		consume = "UPDATE enrollment_tokens SET consumed_at_ms=$1 WHERE token_hash=$2 AND consumed_at_ms IS NULL AND revoked_at_ms IS NULL"
	}
	result, err := tx.ExecContext(ctx, consume, now.UnixMilli(), input.TokenHash)
	if err != nil {
		return AgentRecord{}, err
	}
	if rows, err := result.RowsAffected(); err != nil || rows != 1 {
		return AgentRecord{}, ErrEnrollmentReplay
	}
	var existingAgentBinding string
	existingAgent := "SELECT binding_id FROM agents WHERE id=?"
	if s.dialect == FleetPostgres {
		existingAgent = "SELECT binding_id FROM agents WHERE id=$1 FOR UPDATE"
	}
	err = tx.QueryRowContext(ctx, existingAgent, input.AgentID).Scan(&existingAgentBinding)
	if err == nil && existingAgentBinding != stored.BindingID {
		return AgentRecord{}, ErrEnrollmentBinding
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return AgentRecord{}, err
	}
	if err := replaceBindingAgents(ctx, tx, s.dialect, stored.BindingID, now.UnixMilli()); err != nil {
		return AgentRecord{}, err
	}
	certificateRevision := 1
	certificateRevisionQuery := "SELECT COALESCE(MAX(revision),0)+1 FROM agent_certificates WHERE agent_id=?"
	if s.dialect == FleetPostgres {
		certificateRevisionQuery = "SELECT COALESCE(MAX(revision),0)+1 FROM agent_certificates WHERE agent_id=$1"
	}
	if err := tx.QueryRowContext(ctx, certificateRevisionQuery, input.AgentID).Scan(&certificateRevision); err != nil {
		return AgentRecord{}, err
	}
	observedIdentity := input.ObservedIdentity
	if len(observedIdentity) == 0 {
		observedIdentity = json.RawMessage(`{}`)
	}
	policy := s.livenessPolicy()
	leaseExpiresAt := now.Add(policy.LeaseTTL)
	unavailableAt := leaseExpiresAt.Add(policy.StaleGrace)
	insertAgent := `INSERT INTO agents(id,binding_id,state,protocol_major,protocol_minor,build,observed_identity_json,active_certificate_revision,last_seen_at_ms,lease_expires_at_ms,session_unavailable_at_ms,created_at_ms,updated_at_ms)
VALUES(?,?,'online',?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET binding_id=excluded.binding_id,state='online',protocol_major=excluded.protocol_major,protocol_minor=excluded.protocol_minor,build=excluded.build,observed_identity_json=excluded.observed_identity_json,active_certificate_revision=excluded.active_certificate_revision,last_seen_at_ms=excluded.last_seen_at_ms,lease_expires_at_ms=excluded.lease_expires_at_ms,session_unavailable_at_ms=excluded.session_unavailable_at_ms,updated_at_ms=excluded.updated_at_ms`
	if s.dialect == FleetPostgres {
		insertAgent = `INSERT INTO agents(id,binding_id,state,protocol_major,protocol_minor,build,observed_identity_json,active_certificate_revision,last_seen_at_ms,lease_expires_at_ms,session_unavailable_at_ms,created_at_ms,updated_at_ms)
VALUES($1,$2,'online',$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)
ON CONFLICT(id) DO UPDATE SET binding_id=excluded.binding_id,state='online',protocol_major=excluded.protocol_major,protocol_minor=excluded.protocol_minor,build=excluded.build,observed_identity_json=excluded.observed_identity_json,active_certificate_revision=excluded.active_certificate_revision,last_seen_at_ms=excluded.last_seen_at_ms,lease_expires_at_ms=excluded.lease_expires_at_ms,session_unavailable_at_ms=excluded.session_unavailable_at_ms,updated_at_ms=excluded.updated_at_ms`
	}
	if _, err := tx.ExecContext(ctx, insertAgent, input.AgentID, stored.BindingID, input.ProtocolMajor, input.ProtocolMinor, input.Build, string(observedIdentity), certificateRevision, now.UnixMilli(), leaseExpiresAt.UnixMilli(), unavailableAt.UnixMilli(), now.UnixMilli(), now.UnixMilli()); err != nil {
		return AgentRecord{}, err
	}
	if err := insertAgentCertificate(ctx, tx, s.dialect, input.AgentID, certificateRevision, input.Certificate, now.UnixMilli()); err != nil {
		return AgentRecord{}, err
	}
	if err := replaceAgentCapabilities(ctx, tx, s.dialect, input.AgentID, input.Capabilities, now.UnixMilli(), leaseExpiresAt.UnixMilli()); err != nil {
		return AgentRecord{}, err
	}
	updateBinding := "UPDATE management_bindings SET state='active',updated_at_ms=? WHERE binding_id=?"
	if s.dialect == FleetPostgres {
		updateBinding = "UPDATE management_bindings SET state='active',updated_at_ms=$1 WHERE binding_id=$2"
	}
	if _, err := tx.ExecContext(ctx, updateBinding, now.UnixMilli(), stored.BindingID); err != nil {
		return AgentRecord{}, err
	}
	if err := insertFleetAudit(ctx, tx, s.dialect, actor, stored.ProjectRef, "fleet.agent.enroll", stored.TargetID, input.AgentID, correlationID, now.UnixMilli()); err != nil {
		return AgentRecord{}, err
	}
	if err := tx.Commit(); err != nil {
		return AgentRecord{}, err
	}
	return AgentRecord{ID: input.AgentID, BindingID: stored.BindingID, State: "online", ProtocolMajor: input.ProtocolMajor, ProtocolMinor: input.ProtocolMinor, Build: input.Build, ActiveCertificateRevision: certificateRevision, CertificateExpiresAt: input.Certificate.NotAfter, LastSeenAt: now, LeaseExpiresAt: leaseExpiresAt, UnavailableAt: unavailableAt, SessionState: "online", Capabilities: withObservationWindow(input.Capabilities, now, leaseExpiresAt)}, nil
}

func sameBinding(left, right ManagementBinding) bool {
	return left.BindingID == right.BindingID && left.OrganizationID == right.OrganizationID && left.ProjectRef == right.ProjectRef && left.TargetID == right.TargetID && left.ExecutionTarget == right.ExecutionTarget && left.DeploymentKind == right.DeploymentKind
}

func replaceBindingAgents(ctx context.Context, tx *sql.Tx, dialect StoreDialect, bindingID string, now int64) error {
	certificates := "UPDATE agent_certificates SET state='replaced',revoked_at_ms=? WHERE state IN ('active','overlap') AND agent_id IN (SELECT id FROM agents WHERE binding_id=? AND state IN ('online','offline','incompatible'))"
	agents := "UPDATE agents SET state='replaced',updated_at_ms=? WHERE binding_id=? AND state IN ('online','offline','incompatible')"
	if dialect == FleetPostgres {
		certificates = "UPDATE agent_certificates SET state='replaced',revoked_at_ms=$1 WHERE state IN ('active','overlap') AND agent_id IN (SELECT id FROM agents WHERE binding_id=$2 AND state IN ('online','offline','incompatible'))"
		agents = "UPDATE agents SET state='replaced',updated_at_ms=$1 WHERE binding_id=$2 AND state IN ('online','offline','incompatible')"
	}
	if _, err := tx.ExecContext(ctx, certificates, now, bindingID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, agents, now, bindingID)
	return err
}

func insertAgentCertificate(ctx context.Context, tx *sql.Tx, dialect StoreDialect, agentID string, revision int, certificate IssuedCertificate, now int64) error {
	query := `INSERT INTO agent_certificates(serial,agent_id,revision,fingerprint,state,not_before_ms,not_after_ms,issued_at_ms)
VALUES(?,?,?,?,'active',?,?,?)`
	if dialect == FleetPostgres {
		query = `INSERT INTO agent_certificates(serial,agent_id,revision,fingerprint,state,not_before_ms,not_after_ms,issued_at_ms)
VALUES($1,$2,$3,$4,'active',$5,$6,$7)`
	}
	_, err := tx.ExecContext(ctx, query, certificate.Serial, agentID, revision, certificate.Fingerprint, certificate.NotBefore.UTC().UnixMilli(), certificate.NotAfter.UTC().UnixMilli(), now)
	return err
}

func replaceAgentCapabilities(ctx context.Context, tx *sql.Tx, dialect StoreDialect, agentID string, capabilities []CapabilityObservation, now, validUntil int64) error {
	deleteQuery := "DELETE FROM agent_capabilities WHERE agent_id=?"
	if dialect == FleetPostgres {
		deleteQuery = "DELETE FROM agent_capabilities WHERE agent_id=$1"
	}
	if _, err := tx.ExecContext(ctx, deleteQuery, agentID); err != nil {
		return err
	}
	query := "INSERT INTO agent_capabilities(agent_id,domain,name,contract_version,input_schema,evidence_schema,observed_at_ms,valid_until_ms) VALUES(?,?,?,?,?,?,?,?)"
	if dialect == FleetPostgres {
		query = "INSERT INTO agent_capabilities(agent_id,domain,name,contract_version,input_schema,evidence_schema,observed_at_ms,valid_until_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8)"
	}
	for _, capability := range capabilities {
		if _, err := tx.ExecContext(ctx, query, agentID, capability.Domain, capability.Name, capability.ContractVersion, capability.InputSchema, capability.EvidenceSchema, now, validUntil); err != nil {
			return err
		}
	}
	return nil
}

func withObservationWindow(capabilities []CapabilityObservation, observedAt, validUntil time.Time) []CapabilityObservation {
	result := append([]CapabilityObservation(nil), capabilities...)
	for index := range result {
		result[index].ObservedAt = observedAt
		result[index].ValidUntil = validUntil
	}
	return result
}

func insertFleetAudit(ctx context.Context, tx *sql.Tx, dialect StoreDialect, actor, projectRef, action, targetID, recordID, correlationID string, now int64) error {
	query := "INSERT INTO audit_events(actor,project_ref,action,target_id,operation_id,correlation_id,payload_json,created_at_ms) VALUES(?,?,?,?,?,?,'{}',?)"
	if dialect == FleetPostgres {
		query = "INSERT INTO audit_events(actor,project_ref,action,target_id,operation_id,correlation_id,payload_json,created_at_ms) VALUES($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7)"
	}
	_, err := tx.ExecContext(ctx, query, actor, projectRef, action, targetID, recordID, correlationID, now)
	return err
}

func (s *Store) GetBindingStatus(ctx context.Context, projectRef, bindingID string) (BindingStatus, error) {
	query := `SELECT binding_id,organization_id,project_ref,target_id,execution_target,deployment_kind,allowed_capability_prefixes_json,state,created_at_ms,updated_at_ms
FROM management_bindings WHERE project_ref=? AND binding_id=?`
	if s.dialect == FleetPostgres {
		query = `SELECT binding_id,organization_id,project_ref,target_id,execution_target,deployment_kind,allowed_capability_prefixes_json,state,created_at_ms,updated_at_ms
FROM management_bindings WHERE project_ref=$1 AND binding_id=$2`
	}
	var status BindingStatus
	var prefixes []byte
	var created, updated int64
	if err := s.db.QueryRowContext(ctx, query, projectRef, bindingID).Scan(&status.Binding.BindingID, &status.Binding.OrganizationID, &status.Binding.ProjectRef, &status.Binding.TargetID, &status.Binding.ExecutionTarget, &status.Binding.DeploymentKind, &prefixes, &status.Binding.State, &created, &updated); errors.Is(err, sql.ErrNoRows) {
		return BindingStatus{}, ErrAgentNotFound
	} else if err != nil {
		return BindingStatus{}, err
	}
	if err := json.Unmarshal(prefixes, &status.Binding.AllowedCapabilityPrefixes); err != nil {
		return BindingStatus{}, err
	}
	status.Binding.CreatedAt, status.Binding.UpdatedAt = time.UnixMilli(created).UTC(), time.UnixMilli(updated).UTC()
	agentQuery := `SELECT a.id,a.binding_id,a.state,a.protocol_major,a.protocol_minor,a.build,a.active_certificate_revision,a.last_seen_at_ms,a.lease_expires_at_ms,a.session_unavailable_at_ms,c.not_after_ms
FROM agents a JOIN agent_certificates c ON c.agent_id=a.id AND c.revision=a.active_certificate_revision
WHERE a.binding_id=? AND a.state IN ('online','offline','incompatible') ORDER BY a.updated_at_ms DESC LIMIT 1`
	if s.dialect == FleetPostgres {
		agentQuery = strings.ReplaceAll(agentQuery, "?", "$1")
	}
	var agent AgentRecord
	var lastSeen, expires int64
	var leaseExpires, unavailableAt sql.NullInt64
	err := s.db.QueryRowContext(ctx, agentQuery, bindingID).Scan(&agent.ID, &agent.BindingID, &agent.State, &agent.ProtocolMajor, &agent.ProtocolMinor, &agent.Build, &agent.ActiveCertificateRevision, &lastSeen, &leaseExpires, &unavailableAt, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return status, nil
	}
	if err != nil {
		return BindingStatus{}, err
	}
	agent.LastSeenAt, agent.CertificateExpiresAt = time.UnixMilli(lastSeen).UTC(), time.UnixMilli(expires).UTC()
	policy := s.livenessPolicy()
	if leaseExpires.Valid {
		agent.LeaseExpiresAt = time.UnixMilli(leaseExpires.Int64).UTC()
	} else {
		agent.LeaseExpiresAt = agent.LastSeenAt.Add(policy.LeaseTTL)
	}
	if unavailableAt.Valid {
		agent.UnavailableAt = time.UnixMilli(unavailableAt.Int64).UTC()
	} else {
		agent.UnavailableAt = agent.LeaseExpiresAt.Add(policy.StaleGrace)
	}
	agent.SessionState = sessionState(s.now().UTC(), agent.LeaseExpiresAt, policy.StaleGrace)
	capabilityQuery := "SELECT domain,name,contract_version,input_schema,evidence_schema,observed_at_ms,valid_until_ms FROM agent_capabilities WHERE agent_id=? ORDER BY name"
	if s.dialect == FleetPostgres {
		capabilityQuery = strings.ReplaceAll(capabilityQuery, "?", "$1")
	}
	rows, err := s.db.QueryContext(ctx, capabilityQuery, agent.ID)
	if err != nil {
		return BindingStatus{}, err
	}
	defer rows.Close()
	agent.Capabilities = make([]CapabilityObservation, 0)
	for rows.Next() {
		var capability CapabilityObservation
		var observed int64
		var validUntil sql.NullInt64
		if err := rows.Scan(&capability.Domain, &capability.Name, &capability.ContractVersion, &capability.InputSchema, &capability.EvidenceSchema, &observed, &validUntil); err != nil {
			return BindingStatus{}, err
		}
		capability.ObservedAt = time.UnixMilli(observed).UTC()
		if validUntil.Valid {
			capability.ValidUntil = time.UnixMilli(validUntil.Int64).UTC()
		} else {
			capability.ValidUntil = capability.ObservedAt.Add(policy.LeaseTTL)
		}
		agent.Capabilities = append(agent.Capabilities, capability)
	}
	if err := rows.Err(); err != nil {
		return BindingStatus{}, err
	}
	status.Agent = &agent
	return status, nil
}

func (s *Store) ValidateAgentCertificate(ctx context.Context, agentID, serial string) (ManagementBinding, AgentRecord, error) {
	query := `SELECT b.binding_id,b.organization_id,b.project_ref,b.target_id,b.execution_target,b.deployment_kind,b.allowed_capability_prefixes_json,b.state,b.created_at_ms,b.updated_at_ms,
a.id,a.binding_id,a.state,a.protocol_major,a.protocol_minor,a.build,a.active_certificate_revision,a.last_seen_at_ms,c.not_after_ms,c.state,c.overlap_until_ms
FROM agent_certificates c JOIN agents a ON a.id=c.agent_id JOIN management_bindings b ON b.binding_id=a.binding_id
WHERE c.serial=? AND a.id=?`
	if s.dialect == FleetPostgres {
		query = strings.Replace(query, "?", "$1", 1)
		query = strings.Replace(query, "?", "$2", 1)
	}
	var binding ManagementBinding
	var agent AgentRecord
	var prefixes []byte
	var bindingCreated, bindingUpdated, lastSeen, expires int64
	var certificateState string
	var overlapUntil sql.NullInt64
	err := s.db.QueryRowContext(ctx, query, serial, agentID).Scan(&binding.BindingID, &binding.OrganizationID, &binding.ProjectRef, &binding.TargetID, &binding.ExecutionTarget, &binding.DeploymentKind, &prefixes, &binding.State, &bindingCreated, &bindingUpdated, &agent.ID, &agent.BindingID, &agent.State, &agent.ProtocolMajor, &agent.ProtocolMinor, &agent.Build, &agent.ActiveCertificateRevision, &lastSeen, &expires, &certificateState, &overlapUntil)
	if errors.Is(err, sql.ErrNoRows) {
		return ManagementBinding{}, AgentRecord{}, ErrAgentNotFound
	}
	if err != nil {
		return ManagementBinding{}, AgentRecord{}, err
	}
	now := s.now().UTC().UnixMilli()
	if binding.State == "revoked" || agent.State == "revoked" || certificateState == "revoked" || certificateState == "replaced" || expires < now || (certificateState == "overlap" && (!overlapUntil.Valid || overlapUntil.Int64 < now)) {
		return ManagementBinding{}, AgentRecord{}, ErrCertificateRevoked
	}
	if certificateState != "active" && certificateState != "overlap" {
		return ManagementBinding{}, AgentRecord{}, ErrCertificateRevoked
	}
	if err := json.Unmarshal(prefixes, &binding.AllowedCapabilityPrefixes); err != nil {
		return ManagementBinding{}, AgentRecord{}, err
	}
	binding.CreatedAt, binding.UpdatedAt = time.UnixMilli(bindingCreated).UTC(), time.UnixMilli(bindingUpdated).UTC()
	agent.LastSeenAt, agent.CertificateExpiresAt = time.UnixMilli(lastSeen).UTC(), time.UnixMilli(expires).UTC()
	capabilityQuery := "SELECT domain,name,contract_version,input_schema,evidence_schema,observed_at_ms,valid_until_ms FROM agent_capabilities WHERE agent_id=? ORDER BY name"
	if s.dialect == FleetPostgres {
		capabilityQuery = strings.ReplaceAll(capabilityQuery, "?", "$1")
	}
	rows, err := s.db.QueryContext(ctx, capabilityQuery, agentID)
	if err != nil {
		return ManagementBinding{}, AgentRecord{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var capability CapabilityObservation
		var observed int64
		var validUntil sql.NullInt64
		if err := rows.Scan(&capability.Domain, &capability.Name, &capability.ContractVersion, &capability.InputSchema, &capability.EvidenceSchema, &observed, &validUntil); err != nil {
			return ManagementBinding{}, AgentRecord{}, err
		}
		capability.ObservedAt = time.UnixMilli(observed).UTC()
		if validUntil.Valid {
			capability.ValidUntil = time.UnixMilli(validUntil.Int64).UTC()
		} else {
			capability.ValidUntil = capability.ObservedAt.Add(s.livenessPolicy().LeaseTTL)
		}
		agent.Capabilities = append(agent.Capabilities, capability)
	}
	if err := rows.Err(); err != nil {
		return ManagementBinding{}, AgentRecord{}, err
	}
	return binding, agent, nil
}

func (s *Store) RotateAgentCertificate(ctx context.Context, agentID, currentSerial string, certificate IssuedCertificate, overlap time.Duration, actor, correlationID string) (AgentRecord, error) {
	binding, agent, err := s.ValidateAgentCertificate(ctx, agentID, currentSerial)
	if err != nil {
		return AgentRecord{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AgentRecord{}, err
	}
	defer tx.Rollback()
	now := s.now().UTC()
	overlapUntil := now.Add(overlap)
	if overlapUntil.After(agent.CertificateExpiresAt) {
		overlapUntil = agent.CertificateExpiresAt
	}
	updateOld := "UPDATE agent_certificates SET state='overlap',overlap_until_ms=? WHERE serial=? AND agent_id=? AND state='active'"
	if s.dialect == FleetPostgres {
		updateOld = "UPDATE agent_certificates SET state='overlap',overlap_until_ms=$1 WHERE serial=$2 AND agent_id=$3 AND state='active'"
	}
	result, err := tx.ExecContext(ctx, updateOld, overlapUntil.UnixMilli(), currentSerial, agentID)
	if err != nil {
		return AgentRecord{}, err
	}
	if rows, err := result.RowsAffected(); err != nil || rows != 1 {
		return AgentRecord{}, ErrCertificateRevoked
	}
	newRevision := agent.ActiveCertificateRevision + 1
	if err := insertAgentCertificate(ctx, tx, s.dialect, agentID, newRevision, certificate, now.UnixMilli()); err != nil {
		return AgentRecord{}, err
	}
	updateAgent := "UPDATE agents SET active_certificate_revision=?,last_seen_at_ms=?,updated_at_ms=? WHERE id=?"
	if s.dialect == FleetPostgres {
		updateAgent = "UPDATE agents SET active_certificate_revision=$1,last_seen_at_ms=$2,updated_at_ms=$3 WHERE id=$4"
	}
	if _, err := tx.ExecContext(ctx, updateAgent, newRevision, now.UnixMilli(), now.UnixMilli(), agentID); err != nil {
		return AgentRecord{}, err
	}
	if err := insertFleetAudit(ctx, tx, s.dialect, actor, binding.ProjectRef, "fleet.agent.certificate.rotate", binding.TargetID, agentID, correlationID, now.UnixMilli()); err != nil {
		return AgentRecord{}, err
	}
	if err := tx.Commit(); err != nil {
		return AgentRecord{}, err
	}
	agent.ActiveCertificateRevision = newRevision
	agent.CertificateExpiresAt = certificate.NotAfter
	agent.LastSeenAt = now
	return agent, nil
}

func (s *Store) RecordHeartbeat(ctx context.Context, agentID, serial string, protocolMajor, protocolMinor int, build string, capabilities []CapabilityObservation) (BindingStatus, error) {
	binding, agent, err := s.ValidateAgentCertificate(ctx, agentID, serial)
	if err != nil {
		return BindingStatus{}, err
	}
	if protocolMajor != 1 || protocolMinor < 0 || protocolMinor > 0 || protocolMajor != agent.ProtocolMajor {
		return BindingStatus{}, ErrProtocolMismatch
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return BindingStatus{}, err
	}
	defer tx.Rollback()
	now := s.now().UTC()
	policy := s.livenessPolicy()
	leaseExpiresAt := now.Add(policy.LeaseTTL)
	unavailableAt := leaseExpiresAt.Add(policy.StaleGrace)
	update := "UPDATE agents SET state='online',protocol_minor=?,build=?,last_seen_at_ms=?,lease_expires_at_ms=?,session_unavailable_at_ms=?,updated_at_ms=? WHERE id=?"
	if s.dialect == FleetPostgres {
		update = "UPDATE agents SET state='online',protocol_minor=$1,build=$2,last_seen_at_ms=$3,lease_expires_at_ms=$4,session_unavailable_at_ms=$5,updated_at_ms=$6 WHERE id=$7"
	}
	if _, err := tx.ExecContext(ctx, update, protocolMinor, build, now.UnixMilli(), leaseExpiresAt.UnixMilli(), unavailableAt.UnixMilli(), now.UnixMilli(), agentID); err != nil {
		return BindingStatus{}, err
	}
	if err := replaceAgentCapabilities(ctx, tx, s.dialect, agentID, capabilities, now.UnixMilli(), leaseExpiresAt.UnixMilli()); err != nil {
		return BindingStatus{}, err
	}
	if err := tx.Commit(); err != nil {
		return BindingStatus{}, err
	}
	return s.GetBindingStatus(ctx, binding.ProjectRef, binding.BindingID)
}

// RefreshAgentCapabilities replaces an authenticated Agent's executable
// capability set on reconnect. The control plane supplies the schemas from its
// own registry, while the binding prefix allowlist remains authoritative. This
// permits safe Agent image upgrades without issuing a new trust credential.
func (s *Store) RefreshAgentCapabilities(ctx context.Context, binding ManagementBinding, agentID string, capabilities []CapabilityObservation) error {
	if agentID == "" || binding.BindingID == "" {
		return errors.New("complete Agent capability refresh identity is required")
	}
	if err := validateCapabilityObservations(capabilities, binding.AllowedCapabilityPrefixes); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := s.now().UTC()
	leaseExpiresAt := now.Add(s.livenessPolicy().LeaseTTL)
	if err := replaceAgentCapabilities(ctx, tx, s.dialect, agentID, capabilities, now.UnixMilli(), leaseExpiresAt.UnixMilli()); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) RevokeAgent(ctx context.Context, projectRef, bindingID, agentID, actor, correlationID string) error {
	status, err := s.GetBindingStatus(ctx, projectRef, bindingID)
	if err != nil || status.Agent == nil || status.Agent.ID != agentID {
		return ErrAgentNotFound
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := s.now().UTC().UnixMilli()
	certificates := "UPDATE agent_certificates SET state='revoked',revoked_at_ms=? WHERE agent_id=? AND state IN ('active','overlap')"
	agent := "UPDATE agents SET state='revoked',updated_at_ms=? WHERE id=? AND binding_id=?"
	binding := "UPDATE management_bindings SET state='revoked',updated_at_ms=? WHERE binding_id=? AND project_ref=?"
	tokens := "UPDATE enrollment_tokens SET revoked_at_ms=? WHERE binding_id=? AND consumed_at_ms IS NULL AND revoked_at_ms IS NULL"
	if s.dialect == FleetPostgres {
		certificates = "UPDATE agent_certificates SET state='revoked',revoked_at_ms=$1 WHERE agent_id=$2 AND state IN ('active','overlap')"
		agent = "UPDATE agents SET state='revoked',updated_at_ms=$1 WHERE id=$2 AND binding_id=$3"
		binding = "UPDATE management_bindings SET state='revoked',updated_at_ms=$1 WHERE binding_id=$2 AND project_ref=$3"
		tokens = "UPDATE enrollment_tokens SET revoked_at_ms=$1 WHERE binding_id=$2 AND consumed_at_ms IS NULL AND revoked_at_ms IS NULL"
	}
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{certificates, []any{now, agentID}}, {agent, []any{now, agentID, bindingID}}, {binding, []any{now, bindingID, projectRef}}, {tokens, []any{now, bindingID}},
	} {
		if _, err := tx.ExecContext(ctx, statement.query, statement.args...); err != nil {
			return err
		}
	}
	if err := insertFleetAudit(ctx, tx, s.dialect, actor, projectRef, "fleet.agent.revoke", status.Binding.TargetID, agentID, correlationID, now); err != nil {
		return err
	}
	return tx.Commit()
}

// RevokeManagementBinding is the detach/rebind boundary. It invalidates every
// unconsumed enrollment token and every active certificate for the binding in
// one transaction, including bindings that have not enrolled an Agent yet.
func (s *Store) RevokeManagementBinding(ctx context.Context, projectRef, bindingID, actor, correlationID string) error {
	status, err := s.GetBindingStatus(ctx, projectRef, bindingID)
	if err != nil {
		return err
	}
	if status.Binding.State == "revoked" {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := s.now().UTC().UnixMilli()
	certificates := "UPDATE agent_certificates SET state='revoked',revoked_at_ms=? WHERE agent_id IN (SELECT id FROM agents WHERE binding_id=?) AND state IN ('active','overlap')"
	agents := "UPDATE agents SET state='revoked',updated_at_ms=? WHERE binding_id=? AND state IN ('online','offline','incompatible')"
	binding := "UPDATE management_bindings SET state='revoked',updated_at_ms=? WHERE binding_id=? AND project_ref=? AND state<>'revoked'"
	tokens := "UPDATE enrollment_tokens SET revoked_at_ms=? WHERE binding_id=? AND consumed_at_ms IS NULL AND revoked_at_ms IS NULL"
	if s.dialect == FleetPostgres {
		certificates = "UPDATE agent_certificates SET state='revoked',revoked_at_ms=$1 WHERE agent_id IN (SELECT id FROM agents WHERE binding_id=$2) AND state IN ('active','overlap')"
		agents = "UPDATE agents SET state='revoked',updated_at_ms=$1 WHERE binding_id=$2 AND state IN ('online','offline','incompatible')"
		binding = "UPDATE management_bindings SET state='revoked',updated_at_ms=$1 WHERE binding_id=$2 AND project_ref=$3 AND state<>'revoked'"
		tokens = "UPDATE enrollment_tokens SET revoked_at_ms=$1 WHERE binding_id=$2 AND consumed_at_ms IS NULL AND revoked_at_ms IS NULL"
	}
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{certificates, []any{now, bindingID}},
		{agents, []any{now, bindingID}},
		{binding, []any{now, bindingID, projectRef}},
		{tokens, []any{now, bindingID}},
	} {
		if _, err := tx.ExecContext(ctx, statement.query, statement.args...); err != nil {
			return err
		}
	}
	if err := insertFleetAudit(ctx, tx, s.dialect, actor, projectRef, "fleet.management_binding.revoke", status.Binding.TargetID, bindingID, correlationID, now); err != nil {
		return err
	}
	return tx.Commit()
}

func validateCapabilityObservations(capabilities []CapabilityObservation, allowedPrefixes []string) error {
	if len(capabilities) == 0 || len(capabilities) > 256 {
		return errors.New("between 1 and 256 Agent capabilities are required")
	}
	seen := make(map[string]struct{}, len(capabilities))
	for _, capability := range capabilities {
		if capability.Domain == "" || capability.Name == "" || capability.ContractVersion == "" || capability.InputSchema == "" || capability.EvidenceSchema == "" {
			return errors.New("complete per-domain capability schema evidence is required")
		}
		allowed := false
		for _, prefix := range allowedPrefixes {
			if strings.HasPrefix(capability.Name, prefix) {
				allowed = true
				break
			}
		}
		if !allowed {
			return fmt.Errorf("capability %q is outside the enrollment allowlist", capability.Name)
		}
		schemaPrefix := "supabase." + capability.Domain + "."
		if !strings.HasPrefix(capability.InputSchema, schemaPrefix) || !strings.HasPrefix(capability.EvidenceSchema, schemaPrefix) {
			return fmt.Errorf("capability %q schema is outside domain %q", capability.Name, capability.Domain)
		}
		if _, exists := seen[capability.Name]; exists {
			return fmt.Errorf("duplicate capability %q", capability.Name)
		}
		seen[capability.Name] = struct{}{}
	}
	return nil
}
