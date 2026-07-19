package fleetplatform

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetfunctions"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetproviders"
	"github.com/supabase/supabase/apps/backup-operator/internal/security"
)

type OutboxOperation struct {
	OperationID       string
	ProjectRef        string
	TargetID          string
	BindingID         string
	Domain            string
	Capability        string
	DesiredRevision   string
	DesiredGeneration int64
	DesiredDigest     string
	SnapshotCanonical string
	InputSchema       string
	Preconditions     json.RawMessage
	IdempotencyKey    string
	Actor             string
	CorrelationID     string
}

type Store interface {
	Claim(context.Context, string, time.Duration) (OutboxOperation, bool, error)
	Complete(context.Context, string, string, string) (bool, error)
	Fail(context.Context, string, string, string, string, bool) (bool, error)
}

type FunctionProjection struct {
	OperationID       string
	ProjectRef        string
	Slug              string
	DesiredRevision   string
	DesiredGeneration int64
}

type FunctionProjectionStore interface {
	NextFunctionProjection(context.Context) (FunctionProjection, bool, error)
	ApplyFunctionProjection(context.Context, FunctionProjection, fleetfunctions.Evidence, string) (bool, error)
}

type ConfigurationProjection struct {
	OperationID       string
	ProjectRef        string
	Domain            string
	PolicyRevision    int64
	DesiredRevision   string
	DesiredGeneration int64
}

type ConfigurationProjectionStore interface {
	NextConfigurationProjection(context.Context) (ConfigurationProjection, bool, error)
	ApplyConfigurationProjection(context.Context, ConfigurationProjection, *fleetproviders.Evidence, string, string) (bool, error)
}

type PostgresStore struct{ db *sql.DB }

func OpenPostgres(ctx context.Context, dsn string) (*PostgresStore, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return &PostgresStore{db: db}, nil
}

func (s *PostgresStore) Close() error { return s.db.Close() }

func (s *PostgresStore) Claim(ctx context.Context, worker string, lease time.Duration) (OutboxOperation, bool, error) {
	const query = `SELECT operation_id, project_ref, target_id, binding_id, domain,
capability, desired_revision::text, desired_generation, desired_digest,
snapshot_canonical, input_schema, preconditions, idempotency_key, actor, correlation_id
FROM platform.claim_operation_outbox($1, $2)`
	var operation OutboxOperation
	var preconditions []byte
	err := s.db.QueryRowContext(ctx, query, worker, int(lease.Seconds())).Scan(
		&operation.OperationID, &operation.ProjectRef, &operation.TargetID, &operation.BindingID,
		&operation.Domain, &operation.Capability, &operation.DesiredRevision,
		&operation.DesiredGeneration, &operation.DesiredDigest, &operation.SnapshotCanonical,
		&operation.InputSchema, &preconditions, &operation.IdempotencyKey, &operation.Actor,
		&operation.CorrelationID,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return OutboxOperation{}, false, nil
	}
	if err != nil {
		return OutboxOperation{}, false, err
	}
	operation.Preconditions = append(json.RawMessage(nil), preconditions...)
	return operation, true, nil
}

func (s *PostgresStore) Complete(ctx context.Context, operationID, worker, controlState string) (bool, error) {
	var completed bool
	err := s.db.QueryRowContext(ctx, "SELECT platform.complete_operation_dispatch($1,$2,$3)", operationID, worker, controlState).Scan(&completed)
	return completed, err
}

func (s *PostgresStore) Fail(ctx context.Context, operationID, worker, code, message string, retryable bool) (bool, error) {
	var completed bool
	err := s.db.QueryRowContext(ctx, "SELECT platform.fail_operation_dispatch($1,$2,$3,$4,$5)", operationID, worker, code, message, retryable).Scan(&completed)
	return completed, err
}

func (s *PostgresStore) NextFunctionProjection(ctx context.Context) (FunctionProjection, bool, error) {
	const query = `SELECT deployment.operation_id, deployment.project_ref, deployment.slug,
deployment.desired_revision::text, deployment.generation
FROM platform.function_deployments deployment
JOIN platform.operation_outbox outbox ON outbox.operation_id = deployment.operation_id
WHERE deployment.state = 'queued' AND outbox.delivery_state = 'dispatched'
ORDER BY deployment.updated_at LIMIT 1`
	var candidate FunctionProjection
	err := s.db.QueryRowContext(ctx, query).Scan(&candidate.OperationID, &candidate.ProjectRef, &candidate.Slug, &candidate.DesiredRevision, &candidate.DesiredGeneration)
	if errors.Is(err, sql.ErrNoRows) {
		return FunctionProjection{}, false, nil
	}
	if err != nil {
		return FunctionProjection{}, false, err
	}
	return candidate, true, nil
}

func (s *PostgresStore) ApplyFunctionProjection(ctx context.Context, candidate FunctionProjection, evidence fleetfunctions.Evidence, errorCode string) (bool, error) {
	typedEvidence, err := json.Marshal(evidence)
	if err != nil {
		return false, err
	}
	var applied bool
	err = s.db.QueryRowContext(ctx, `SELECT platform.apply_function_deployment_observation(
$1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12::jsonb
)`, candidate.ProjectRef, candidate.Slug, candidate.OperationID, candidate.DesiredRevision,
		candidate.DesiredGeneration, evidence.Status, evidence.ArtifactDigest,
		evidence.PreviousDigest, errorCode, evidence.Remediation, evidence.ActivatedAt,
		string(typedEvidence)).Scan(&applied)
	return applied, err
}

func (s *PostgresStore) NextConfigurationProjection(ctx context.Context) (ConfigurationProjection, bool, error) {
	const query = `SELECT operation_id, project_ref, domain, policy_revision,
desired_revision::text, desired_generation
FROM platform.next_configuration_projection()`
	var candidate ConfigurationProjection
	err := s.db.QueryRowContext(ctx, query).Scan(
		&candidate.OperationID,
		&candidate.ProjectRef,
		&candidate.Domain,
		&candidate.PolicyRevision,
		&candidate.DesiredRevision,
		&candidate.DesiredGeneration,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return ConfigurationProjection{}, false, nil
	}
	if err != nil {
		return ConfigurationProjection{}, false, err
	}
	return candidate, true, nil
}

func (s *PostgresStore) ApplyConfigurationProjection(ctx context.Context, candidate ConfigurationProjection, evidence *fleetproviders.Evidence, operationState, errorCode string) (bool, error) {
	if evidence == nil {
		var applied bool
		err := s.db.QueryRowContext(ctx, `SELECT platform.apply_configuration_operation_failure(
$1,$2,$3::uuid,$4,$5
)`, candidate.ProjectRef, candidate.OperationID, candidate.DesiredRevision,
			candidate.DesiredGeneration, errorCode).Scan(&applied)
		return applied, err
	}
	blockers, err := json.Marshal(evidence.Conflicts)
	if err != nil {
		return false, err
	}
	var applied bool
	err = s.db.QueryRowContext(ctx, `SELECT platform.apply_configuration_reconciliation_evidence(
$1,$2,$3,$4::uuid,$5,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::timestamptz
)`, candidate.ProjectRef, candidate.Domain, candidate.PolicyRevision,
		candidate.DesiredRevision, candidate.DesiredGeneration,
		string(evidence.ObservedDocument), evidence.ObservedDigest, candidate.OperationID,
		evidence.DriftState, evidence.Applied && operationState == "succeeded", evidence.ObservationOnly, string(blockers),
		errorCode, time.Now().UTC()).Scan(&applied)
	return applied, err
}

type Config struct {
	Store             Store
	FleetControlURL   string
	AssertionKey      []byte
	AssertionIssuer   string
	AssertionAudience string
	WorkerID          string
	Lease             time.Duration
	PollInterval      time.Duration
	HTTPClient        *http.Client
	Now               func() time.Time
	Logger            *slog.Logger
}

func (c Config) validate() error {
	parsed, err := url.Parse(c.FleetControlURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return errors.New("valid Fleet Control URL is required")
	}
	if c.Store == nil || len(c.AssertionKey) < 32 || c.AssertionIssuer == "" || c.AssertionAudience == "" || c.WorkerID == "" {
		return errors.New("outbox store, assertion identity, and worker identity are required")
	}
	if c.Lease < 5*time.Second || c.Lease > 5*time.Minute || c.PollInterval <= 0 {
		return errors.New("outbox lease or poll interval is invalid")
	}
	return nil
}

func (c Config) DispatchOnce(ctx context.Context) (bool, error) {
	if err := c.validate(); err != nil {
		return false, err
	}
	operation, ok, err := c.Store.Claim(ctx, c.WorkerID, c.Lease)
	if err != nil || !ok {
		return ok, err
	}
	controlState, dispatchErr := c.dispatch(ctx, operation)
	if dispatchErr == nil {
		completed, err := c.Store.Complete(ctx, operation.OperationID, c.WorkerID, controlState)
		if err != nil {
			return true, err
		}
		if !completed {
			return true, errors.New("outbox dispatch lease was lost before completion")
		}
		return true, nil
	}
	var fleetErr *FleetError
	retryable := true
	code := "downstream_unavailable"
	message := dispatchErr.Error()
	if errors.As(dispatchErr, &fleetErr) {
		retryable, code, message = fleetErr.Retryable, fleetErr.Code, fleetErr.Message
	}
	completed, err := c.Store.Fail(ctx, operation.OperationID, c.WorkerID, code, message, retryable)
	if err != nil {
		return true, err
	}
	if !completed {
		return true, errors.New("outbox dispatch lease was lost before failure recording")
	}
	return true, nil
}

func (c Config) ProjectFunctionOnce(ctx context.Context) (bool, error) {
	store, ok := c.Store.(FunctionProjectionStore)
	if !ok {
		return false, nil
	}
	candidate, ok, err := store.NextFunctionProjection(ctx)
	if err != nil || !ok {
		return ok, err
	}
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	assertion, err := security.SignServiceJWT(security.ServiceClaims{
		Issuer: c.AssertionIssuer, Subject: "fleet-platform-projector", Audience: c.AssertionAudience,
		NotBefore: now().Add(-5 * time.Second).Unix(), Expires: now().Add(time.Minute).Unix(),
		Scopes: []string{"fleet.read"}, Projects: []string{candidate.ProjectRef},
	}, c.AssertionKey)
	if err != nil {
		return true, err
	}
	endpoint := strings.TrimRight(c.FleetControlURL, "/") + "/platform/fleet/v1/projects/" + url.PathEscape(candidate.ProjectRef) + "/operations/" + url.PathEscape(candidate.OperationID)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return true, err
	}
	request.Header.Set("Authorization", "Bearer "+assertion)
	client := c.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return true, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return true, err
	}
	if response.StatusCode != http.StatusOK || !strings.Contains(response.Header.Get("Content-Type"), "application/json") {
		return true, &FleetError{Code: "downstream_invalid_response", Message: fmt.Sprintf("Fleet Control operation projection returned HTTP %d", response.StatusCode), Retryable: response.StatusCode >= 500}
	}
	var operation struct {
		ID             string          `json:"id"`
		ProjectRef     string          `json:"projectRef"`
		State          string          `json:"state"`
		EvidenceSchema string          `json:"evidenceSchema"`
		Evidence       json.RawMessage `json:"evidence"`
		ErrorCode      string          `json:"errorCode"`
	}
	if json.Unmarshal(payload, &operation) != nil || operation.ID != candidate.OperationID || operation.ProjectRef != candidate.ProjectRef {
		return true, &FleetError{Code: "downstream_invalid_response", Message: "Fleet Control returned mismatched function operation evidence", Retryable: false}
	}
	if operation.State != "succeeded" && operation.State != "failed" && operation.State != "cancelled" && operation.State != "timed_out" {
		return false, nil
	}
	var evidence fleetfunctions.Evidence
	if operation.EvidenceSchema != fleetfunctions.EvidenceSchemaV1 || json.Unmarshal(operation.Evidence, &evidence) != nil || evidence.Schema != fleetfunctions.EvidenceSchemaV1 || evidence.Slug != candidate.Slug || evidence.ObservedGeneration != candidate.DesiredGeneration {
		return true, &FleetError{Code: "downstream_invalid_response", Message: "Fleet Control returned invalid function deployment evidence", Retryable: false}
	}
	applied, err := store.ApplyFunctionProjection(ctx, candidate, evidence, operation.ErrorCode)
	if err != nil {
		return true, err
	}
	if !applied {
		return true, errors.New("stale function deployment evidence was rejected")
	}
	return true, nil
}

func (c Config) ProjectConfigurationOnce(ctx context.Context) (bool, error) {
	store, ok := c.Store.(ConfigurationProjectionStore)
	if !ok {
		return false, nil
	}
	candidate, ok, err := store.NextConfigurationProjection(ctx)
	if err != nil || !ok {
		return ok, err
	}
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	assertion, err := security.SignServiceJWT(security.ServiceClaims{
		Issuer: c.AssertionIssuer, Subject: "fleet-platform-projector", Audience: c.AssertionAudience,
		NotBefore: now().Add(-5 * time.Second).Unix(), Expires: now().Add(time.Minute).Unix(),
		Scopes: []string{"fleet.read"}, Projects: []string{candidate.ProjectRef},
	}, c.AssertionKey)
	if err != nil {
		return true, err
	}
	endpoint := strings.TrimRight(c.FleetControlURL, "/") + "/platform/fleet/v1/projects/" + url.PathEscape(candidate.ProjectRef) + "/operations/" + url.PathEscape(candidate.OperationID)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return true, err
	}
	request.Header.Set("Authorization", "Bearer "+assertion)
	client := c.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return true, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return true, err
	}
	if response.StatusCode != http.StatusOK || !strings.Contains(response.Header.Get("Content-Type"), "application/json") {
		return true, &FleetError{Code: "downstream_invalid_response", Message: fmt.Sprintf("Fleet Control operation projection returned HTTP %d", response.StatusCode), Retryable: response.StatusCode >= 500}
	}
	var operation struct {
		ID             string          `json:"id"`
		ProjectRef     string          `json:"projectRef"`
		State          string          `json:"state"`
		EvidenceSchema string          `json:"evidenceSchema"`
		Evidence       json.RawMessage `json:"evidence"`
		ErrorCode      string          `json:"errorCode"`
	}
	if json.Unmarshal(payload, &operation) != nil || operation.ID != candidate.OperationID || operation.ProjectRef != candidate.ProjectRef {
		return true, &FleetError{Code: "downstream_invalid_response", Message: "Fleet Control returned mismatched configuration operation evidence", Retryable: false}
	}
	if operation.State != "succeeded" && operation.State != "failed" && operation.State != "cancelled" && operation.State != "timed_out" {
		return false, nil
	}
	var evidence fleetproviders.Evidence
	validEvidence := operation.EvidenceSchema == fleetproviders.EvidenceSchemaV1 &&
		json.Unmarshal(operation.Evidence, &evidence) == nil &&
		evidence.Schema == fleetproviders.EvidenceSchemaV1 &&
		evidence.ObservedGeneration == candidate.DesiredGeneration &&
		len(evidence.ObservedDigest) == 64 && json.Valid(evidence.ObservedDocument) &&
		(evidence.DriftState == "in-sync" || evidence.DriftState == "drifted" || evidence.DriftState == "ownership-conflict")
	if operation.State == "succeeded" && (!validEvidence || (!evidence.Applied && !evidence.ObservationOnly)) {
		return true, &FleetError{Code: "downstream_invalid_response", Message: "Fleet Control marked unapplied configuration evidence as applied", Retryable: false}
	}
	var typedEvidence *fleetproviders.Evidence
	if validEvidence {
		typedEvidence = &evidence
	}
	applied, err := store.ApplyConfigurationProjection(ctx, candidate, typedEvidence, operation.State, operation.ErrorCode)
	if err != nil {
		return true, err
	}
	if !applied {
		return true, errors.New("stale configuration evidence was rejected")
	}
	return true, nil
}

type FleetError struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *FleetError) Error() string { return e.Code + ": " + e.Message }

func (c Config) dispatch(ctx context.Context, operation OutboxOperation) (string, error) {
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	current := now()
	assertion, err := security.SignServiceJWT(security.ServiceClaims{
		Issuer: c.AssertionIssuer, Subject: operation.Actor, Audience: c.AssertionAudience,
		NotBefore: current.Add(-5 * time.Second).Unix(), Expires: current.Add(time.Minute).Unix(),
		Scopes: []string{"fleet.execute"}, Projects: []string{operation.ProjectRef},
	}, c.AssertionKey)
	if err != nil {
		return "", err
	}
	body, err := json.Marshal(map[string]any{
		"operationId": operation.OperationID, "targetId": operation.TargetID,
		"bindingId": operation.BindingID, "domain": operation.Domain,
		"capability": operation.Capability, "protocolMajor": 1, "protocolMinor": 0,
		"expectedGeneration": operation.DesiredGeneration,
		"desiredRevision":    operation.DesiredRevision, "desiredDigest": operation.DesiredDigest,
		"snapshotCanonical": operation.SnapshotCanonical, "inputSchema": operation.InputSchema,
		"preconditions": operation.Preconditions, "typedInput": json.RawMessage(operation.SnapshotCanonical),
	})
	if err != nil {
		return "", err
	}
	endpoint := strings.TrimRight(c.FleetControlURL, "/") + "/platform/fleet/v1/projects/" + url.PathEscape(operation.ProjectRef) + "/operations"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+assertion)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", operation.IdempotencyKey)
	request.Header.Set("X-Correlation-ID", operation.CorrelationID)
	client := c.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusCreated {
		var fleetError struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			Retryable bool   `json:"retryable"`
		}
		if !strings.Contains(response.Header.Get("Content-Type"), "application/json") || json.Unmarshal(payload, &fleetError) != nil || fleetError.Code == "" {
			return "", &FleetError{Code: "downstream_invalid_response", Message: fmt.Sprintf("Fleet Control returned HTTP %d", response.StatusCode), Retryable: response.StatusCode >= 500}
		}
		return "", &FleetError{Code: fleetError.Code, Message: fleetError.Message, Retryable: fleetError.Retryable}
	}
	var accepted struct {
		ID              string `json:"id"`
		ProjectRef      string `json:"projectRef"`
		State           string `json:"state"`
		DesiredRevision string `json:"desiredRevision"`
		DesiredDigest   string `json:"desiredDigest"`
	}
	if !strings.Contains(response.Header.Get("Content-Type"), "application/json") || json.Unmarshal(payload, &accepted) != nil || accepted.ID != operation.OperationID || accepted.ProjectRef != operation.ProjectRef || accepted.DesiredRevision != operation.DesiredRevision || accepted.DesiredDigest != operation.DesiredDigest {
		return "", &FleetError{Code: "downstream_invalid_response", Message: "Fleet Control returned a mismatched operation snapshot", Retryable: false}
	}
	return accepted.State, nil
}

func Run(ctx context.Context, cfg Config) error {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if err := cfg.validate(); err != nil {
		return err
	}
	ticker := time.NewTicker(cfg.PollInterval)
	defer ticker.Stop()
	for {
		for {
			dispatched, err := cfg.DispatchOnce(ctx)
			if err != nil {
				cfg.Logger.Error("Fleet platform outbox dispatch failed", "error", err)
				break
			}
			if !dispatched {
				break
			}
		}
		if _, err := cfg.ProjectFunctionOnce(ctx); err != nil {
			cfg.Logger.Error("Fleet function deployment projection failed", "error", err)
		}
		if _, err := cfg.ProjectConfigurationOnce(ctx); err != nil {
			cfg.Logger.Error("Fleet configuration projection failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
