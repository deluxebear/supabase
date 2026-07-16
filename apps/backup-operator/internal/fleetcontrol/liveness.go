package fleetcontrol

import (
	"context"
	"errors"
	"time"
)

type LivenessPolicy struct {
	LeaseTTL   time.Duration
	StaleGrace time.Duration
}

func DefaultLivenessPolicy() LivenessPolicy {
	return LivenessPolicy{LeaseTTL: 30 * time.Second, StaleGrace: 30 * time.Second}
}

func (p LivenessPolicy) Validate() error {
	if p.LeaseTTL < 10*time.Second || p.LeaseTTL > 5*time.Minute {
		return errors.New("Fleet Agent lease TTL must be between 10 seconds and 5 minutes")
	}
	if p.StaleGrace < 0 || p.StaleGrace > 5*time.Minute {
		return errors.New("Fleet Agent stale grace must be between 0 and 5 minutes")
	}
	return nil
}

func (s *Store) SetLivenessPolicy(policy LivenessPolicy) error {
	if err := policy.Validate(); err != nil {
		return err
	}
	s.liveness = policy
	return nil
}

func (s *Store) livenessPolicy() LivenessPolicy {
	policy := s.liveness
	if policy.LeaseTTL == 0 {
		policy = DefaultLivenessPolicy()
	}
	return policy
}

func sessionState(now, leaseExpiresAt time.Time, grace time.Duration) string {
	if !now.After(leaseExpiresAt) {
		return "online"
	}
	if !now.After(leaseExpiresAt.Add(grace)) {
		return "stale"
	}
	return "unavailable"
}

func (s *Store) ExpireAgentLeases(ctx context.Context) (int64, error) {
	policy := s.livenessPolicy()
	cutoff := s.now().UTC().Add(-policy.StaleGrace).UnixMilli()
	query := "UPDATE agents SET state='offline',updated_at_ms=? WHERE state='online' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms<?"
	args := []any{s.now().UTC().UnixMilli(), cutoff}
	if s.dialect == FleetPostgres {
		query = "UPDATE agents SET state='offline',updated_at_ms=$1 WHERE state='online' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms<$2"
	}
	result, err := s.db.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}
