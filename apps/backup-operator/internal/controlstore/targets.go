package controlstore

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

var ErrTargetNotFound = errors.New("target not found")

type TargetRecord struct {
	ProjectID        string
	TargetID         string
	SystemIdentifier string
	DataDomain       string
	CreatedAt        time.Time
}

func (s *Store) GetTarget(ctx context.Context, targetID string) (TargetRecord, error) {
	query := `SELECT project_id,target_id,system_identifier,data_domain,created_at_ms FROM targets WHERE target_id=? ORDER BY created_at_ms DESC LIMIT 1`
	if s.dialect == Postgres {
		query = `SELECT project_id,target_id,system_identifier,data_domain,created_at_ms FROM targets WHERE target_id=$1 ORDER BY created_at_ms DESC LIMIT 1`
	}
	var target TargetRecord
	var createdAt int64
	if err := s.db.QueryRowContext(ctx, query, targetID).Scan(&target.ProjectID, &target.TargetID, &target.SystemIdentifier, &target.DataDomain, &createdAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return target, ErrTargetNotFound
		}
		return target, err
	}
	target.CreatedAt = time.UnixMilli(createdAt).UTC()
	return target, nil
}

func (s *Store) ListTargets(ctx context.Context, projectID string) ([]TargetRecord, error) {
	query := `SELECT project_id,target_id,system_identifier,data_domain,created_at_ms FROM targets WHERE project_id=? ORDER BY target_id`
	if s.dialect == Postgres {
		query = `SELECT project_id,target_id,system_identifier,data_domain,created_at_ms FROM targets WHERE project_id=$1 ORDER BY target_id`
	}
	rows, err := s.db.QueryContext(ctx, query, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var targets []TargetRecord
	for rows.Next() {
		var target TargetRecord
		var createdAt int64
		if err := rows.Scan(&target.ProjectID, &target.TargetID, &target.SystemIdentifier, &target.DataDomain, &createdAt); err != nil {
			return nil, err
		}
		target.CreatedAt = time.UnixMilli(createdAt).UTC()
		targets = append(targets, target)
	}
	return targets, rows.Err()
}

func (s *Store) RegisterCluster(ctx context.Context, target TargetRecord) error {
	return s.RegisterTarget(ctx, contracts.TargetRef{ProjectID: target.ProjectID, TargetID: target.TargetID}, contracts.RecoveryDomain{SystemIdentifier: target.SystemIdentifier, DataDomain: target.DataDomain})
}
