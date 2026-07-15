package fleetcontrol

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"
)

var ErrCapacityExceeded = errors.New("Fleet capacity quota exceeded")

// CapacityPolicy is the tested, fail-closed operating envelope for one Fleet
// Control installation. Values are intentionally configurable only inside
// safe maxima; raising those maxima requires a new capacity result.
type CapacityPolicy struct {
	MaxAgentSessions                int
	MaxConcurrentOperations         int
	MaxConcurrentPerTarget          int
	MaxQueuedPerOrganization        int
	MaxQueuedPerTarget              int
	MaxArtifactBytesPerProject      int64
	MaxArtifactBytesPerOrganization int64
	MaxEventsPerOperation           int
	TerminalEventRetention          time.Duration
	AuditRetention                  time.Duration
	RetentionBatchSize              int
}

func DefaultCapacityPolicy() CapacityPolicy {
	return CapacityPolicy{
		MaxAgentSessions: 300, MaxConcurrentOperations: 20, MaxConcurrentPerTarget: 2,
		MaxQueuedPerOrganization: 1000, MaxQueuedPerTarget: 100,
		MaxArtifactBytesPerProject: 1 << 30, MaxArtifactBytesPerOrganization: 20 << 30,
		MaxEventsPerOperation: 10_000, TerminalEventRetention: 30 * 24 * time.Hour,
		AuditRetention: 365 * 24 * time.Hour, RetentionBatchSize: 10_000,
	}
}

func (p CapacityPolicy) Validate() error {
	if p.MaxAgentSessions < 1 || p.MaxAgentSessions > 10_000 ||
		p.MaxConcurrentOperations < 1 || p.MaxConcurrentOperations > 256 ||
		p.MaxConcurrentPerTarget < 1 || p.MaxConcurrentPerTarget > p.MaxConcurrentOperations ||
		p.MaxQueuedPerOrganization < 1 || p.MaxQueuedPerOrganization > 100_000 ||
		p.MaxQueuedPerTarget < 1 || p.MaxQueuedPerTarget > p.MaxQueuedPerOrganization ||
		p.MaxArtifactBytesPerProject < 1 || p.MaxArtifactBytesPerOrganization < p.MaxArtifactBytesPerProject ||
		p.MaxArtifactBytesPerOrganization > 1<<40 || p.MaxEventsPerOperation < 100 || p.MaxEventsPerOperation > 100_000 ||
		p.TerminalEventRetention <= 0 || p.AuditRetention <= 0 || p.RetentionBatchSize < 1 || p.RetentionBatchSize > 10_000 {
		return errors.New("Fleet capacity policy is outside the supported safe maxima")
	}
	return nil
}

type SessionLimiter struct {
	mu       sync.Mutex
	limit    int
	active   int
	byTarget map[string]int
}

type CapacitySnapshot struct {
	QueuedOperations int
	ActiveOperations int
	LiveEvents       int
}

func (s *Store) CapacitySnapshot(ctx context.Context) (CapacitySnapshot, error) {
	var snapshot CapacitySnapshot
	query := `SELECT
COALESCE(SUM(CASE WHEN state='queued' THEN 1 ELSE 0 END),0),
COALESCE(SUM(CASE WHEN state='applying' THEN 1 ELSE 0 END),0)
FROM operations`
	if err := s.db.QueryRowContext(ctx, query).Scan(&snapshot.QueuedOperations, &snapshot.ActiveOperations); err != nil {
		return snapshot, err
	}
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM operation_events").Scan(&snapshot.LiveEvents); err != nil {
		return snapshot, err
	}
	return snapshot, nil
}

func NewSessionLimiter(limit int) (*SessionLimiter, error) {
	if limit < 1 || limit > 10_000 {
		return nil, errors.New("Fleet Agent session limit must be between 1 and 10000")
	}
	return &SessionLimiter{limit: limit, byTarget: map[string]int{}}, nil
}

func (l *SessionLimiter) Acquire(targetID string) (func(), bool) {
	if l == nil || targetID == "" {
		return func() {}, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.active >= l.limit {
		return func() {}, false
	}
	l.active++
	l.byTarget[targetID]++
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			l.active--
			l.byTarget[targetID]--
			if l.byTarget[targetID] == 0 {
				delete(l.byTarget, targetID)
			}
		})
	}, true
}

func (l *SessionLimiter) Active() int {
	if l == nil {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.active
}

func (s *Store) SetCapacityPolicy(policy CapacityPolicy) error {
	if err := policy.Validate(); err != nil {
		return err
	}
	s.capacity = policy
	return nil
}

func (s *Store) CheckOperationQuota(ctx context.Context, organizationID, targetID, projectRef, idempotencyKey string) error {
	if organizationID == "" || targetID == "" || projectRef == "" || idempotencyKey == "" {
		return errors.New("complete Fleet quota identity is required")
	}
	var existing int
	query := "SELECT COUNT(*) FROM operations WHERE project_ref=? AND idempotency_key=?"
	if s.dialect == FleetPostgres {
		query = "SELECT COUNT(*) FROM operations WHERE project_ref=$1 AND idempotency_key=$2"
	}
	if err := s.db.QueryRowContext(ctx, query, projectRef, idempotencyKey).Scan(&existing); err != nil {
		return err
	}
	if existing > 0 {
		return nil
	}
	policy := s.capacity
	queuedStates := "('queued','applying')"
	orgQuery := `SELECT COUNT(*) FROM operations o JOIN management_bindings b ON b.binding_id=o.binding_id WHERE b.organization_id=? AND o.state IN ` + queuedStates
	targetQuery := `SELECT COUNT(*) FROM operations WHERE target_id=? AND state IN ` + queuedStates
	if s.dialect == FleetPostgres {
		orgQuery = `SELECT COUNT(*) FROM operations o JOIN management_bindings b ON b.binding_id=o.binding_id WHERE b.organization_id=$1 AND o.state IN ` + queuedStates
		targetQuery = `SELECT COUNT(*) FROM operations WHERE target_id=$1 AND state IN ` + queuedStates
	}
	var orgQueued, targetQueued int
	if err := s.db.QueryRowContext(ctx, orgQuery, organizationID).Scan(&orgQueued); err != nil {
		return err
	}
	if err := s.db.QueryRowContext(ctx, targetQuery, targetID).Scan(&targetQueued); err != nil {
		return err
	}
	if orgQueued >= policy.MaxQueuedPerOrganization {
		return fmt.Errorf("%w: organization queued operation limit %d", ErrCapacityExceeded, policy.MaxQueuedPerOrganization)
	}
	if targetQueued >= policy.MaxQueuedPerTarget {
		return fmt.Errorf("%w: target queued operation limit %d", ErrCapacityExceeded, policy.MaxQueuedPerTarget)
	}
	return nil
}

type rowQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func (s *Store) operationCapacityAvailable(ctx context.Context, queryer rowQuerier, targetID string) (bool, error) {
	query := "SELECT COUNT(*), COALESCE(SUM(CASE WHEN target_id=? THEN 1 ELSE 0 END),0) FROM operations WHERE state='applying'"
	if s.dialect == FleetPostgres {
		query = "SELECT COUNT(*), COALESCE(SUM(CASE WHEN target_id=$1 THEN 1 ELSE 0 END),0) FROM operations WHERE state='applying'"
	}
	var global, target int
	if err := queryer.QueryRowContext(ctx, query, targetID).Scan(&global, &target); err != nil {
		return false, err
	}
	return global < s.capacity.MaxConcurrentOperations && target < s.capacity.MaxConcurrentPerTarget, nil
}

func (s *Store) enforceOperationQuotaTx(ctx context.Context, tx *sql.Tx, projectRef, targetID, bindingID string) error {
	orgQuery := `SELECT organization_id FROM management_bindings WHERE binding_id=? AND project_ref=? AND target_id=? AND state='active'`
	if s.dialect == FleetPostgres {
		orgQuery = `SELECT organization_id FROM management_bindings WHERE binding_id=$1 AND project_ref=$2 AND target_id=$3 AND state='active'`
	}
	var organizationID string
	if err := tx.QueryRowContext(ctx, orgQuery, bindingID, projectRef, targetID).Scan(&organizationID); errors.Is(err, sql.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	if s.dialect == FleetPostgres {
		if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "fleet-capacity/org/"+organizationID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "fleet-capacity/target/"+targetID); err != nil {
			return err
		}
	}
	states := "('queued','applying')"
	organizationQuery := `SELECT COUNT(*) FROM operations o JOIN management_bindings b ON b.binding_id=o.binding_id WHERE b.organization_id=? AND o.state IN ` + states
	targetQuery := `SELECT COUNT(*) FROM operations WHERE target_id=? AND state IN ` + states
	if s.dialect == FleetPostgres {
		organizationQuery = `SELECT COUNT(*) FROM operations o JOIN management_bindings b ON b.binding_id=o.binding_id WHERE b.organization_id=$1 AND o.state IN ` + states
		targetQuery = `SELECT COUNT(*) FROM operations WHERE target_id=$1 AND state IN ` + states
	}
	var organizationQueued, targetQueued int
	if err := tx.QueryRowContext(ctx, organizationQuery, organizationID).Scan(&organizationQueued); err != nil {
		return err
	}
	if err := tx.QueryRowContext(ctx, targetQuery, targetID).Scan(&targetQueued); err != nil {
		return err
	}
	if organizationQueued >= s.capacity.MaxQueuedPerOrganization {
		return fmt.Errorf("%w: organization queued operation limit %d", ErrCapacityExceeded, s.capacity.MaxQueuedPerOrganization)
	}
	if targetQueued >= s.capacity.MaxQueuedPerTarget {
		return fmt.Errorf("%w: target queued operation limit %d", ErrCapacityExceeded, s.capacity.MaxQueuedPerTarget)
	}
	return nil
}

func (s *Store) CheckArtifactQuota(ctx context.Context, projectRef string, additional int64) error {
	if projectRef == "" || additional < 0 {
		return errors.New("valid artifact quota request is required")
	}
	var projectBytes int64
	query := "SELECT COALESCE(SUM(size_bytes),0) FROM function_artifacts WHERE project_ref=?"
	if s.dialect == FleetPostgres {
		query = "SELECT COALESCE(SUM(size_bytes),0) FROM function_artifacts WHERE project_ref=$1"
	}
	if err := s.db.QueryRowContext(ctx, query, projectRef).Scan(&projectBytes); err != nil {
		return err
	}
	if projectBytes+additional > s.capacity.MaxArtifactBytesPerProject {
		return fmt.Errorf("%w: project artifact byte limit %d", ErrCapacityExceeded, s.capacity.MaxArtifactBytesPerProject)
	}
	orgQuery := `SELECT b.organization_id FROM management_bindings b WHERE b.project_ref=? AND b.state='active' LIMIT 1`
	if s.dialect == FleetPostgres {
		orgQuery = `SELECT b.organization_id FROM management_bindings b WHERE b.project_ref=$1 AND b.state='active' LIMIT 1`
	}
	var organizationID string
	if err := s.db.QueryRowContext(ctx, orgQuery, projectRef).Scan(&organizationID); errors.Is(err, sql.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	sumQuery := `SELECT COALESCE(SUM(a.size_bytes),0) FROM function_artifacts a JOIN management_bindings b ON b.project_ref=a.project_ref WHERE b.organization_id=? AND b.state='active'`
	if s.dialect == FleetPostgres {
		sumQuery = `SELECT COALESCE(SUM(a.size_bytes),0) FROM function_artifacts a JOIN management_bindings b ON b.project_ref=a.project_ref WHERE b.organization_id=$1 AND b.state='active'`
	}
	var organizationBytes int64
	if err := s.db.QueryRowContext(ctx, sumQuery, organizationID).Scan(&organizationBytes); err != nil {
		return err
	}
	if organizationBytes+additional > s.capacity.MaxArtifactBytesPerOrganization {
		return fmt.Errorf("%w: organization artifact byte limit %d", ErrCapacityExceeded, s.capacity.MaxArtifactBytesPerOrganization)
	}
	return nil
}

func (s *Store) enforceArtifactQuotaTx(ctx context.Context, tx *sql.Tx, projectRef string, additional int64) error {
	organizationQuery := `SELECT organization_id FROM management_bindings WHERE project_ref=? AND state='active' LIMIT 1`
	if s.dialect == FleetPostgres {
		organizationQuery = `SELECT organization_id FROM management_bindings WHERE project_ref=$1 AND state='active' LIMIT 1`
	}
	var organizationID string
	if err := tx.QueryRowContext(ctx, organizationQuery, projectRef).Scan(&organizationID); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	projectQuery := `SELECT COALESCE(SUM(size_bytes),0) FROM function_artifacts WHERE project_ref=?`
	if s.dialect == FleetPostgres {
		projectQuery = `SELECT COALESCE(SUM(size_bytes),0) FROM function_artifacts WHERE project_ref=$1`
	}
	var projectBytes int64
	if err := tx.QueryRowContext(ctx, projectQuery, projectRef).Scan(&projectBytes); err != nil {
		return err
	}
	if projectBytes+additional > s.capacity.MaxArtifactBytesPerProject {
		return fmt.Errorf("%w: project artifact byte limit %d", ErrCapacityExceeded, s.capacity.MaxArtifactBytesPerProject)
	}
	if organizationID == "" {
		return nil
	}
	organizationBytesQuery := `SELECT COALESCE(SUM(a.size_bytes),0) FROM function_artifacts a JOIN management_bindings b ON b.project_ref=a.project_ref WHERE b.organization_id=? AND b.state='active'`
	if s.dialect == FleetPostgres {
		organizationBytesQuery = `SELECT COALESCE(SUM(a.size_bytes),0) FROM function_artifacts a JOIN management_bindings b ON b.project_ref=a.project_ref WHERE b.organization_id=$1 AND b.state='active'`
	}
	var organizationBytes int64
	if err := tx.QueryRowContext(ctx, organizationBytesQuery, organizationID).Scan(&organizationBytes); err != nil {
		return err
	}
	if organizationBytes+additional > s.capacity.MaxArtifactBytesPerOrganization {
		return fmt.Errorf("%w: organization artifact byte limit %d", ErrCapacityExceeded, s.capacity.MaxArtifactBytesPerOrganization)
	}
	return nil
}

func (s *Store) lockArtifactQuotaTx(ctx context.Context, tx *sql.Tx, projectRef string) error {
	if s.dialect != FleetPostgres {
		return nil
	}
	var organizationID string
	if err := tx.QueryRowContext(ctx, `SELECT organization_id FROM management_bindings WHERE project_ref=$1 AND state='active' LIMIT 1`, projectRef).Scan(&organizationID); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if organizationID != "" {
		if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "fleet-capacity/artifacts/org/"+organizationID); err != nil {
			return err
		}
	}
	_, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "fleet-capacity/artifacts/project/"+projectRef)
	return err
}
