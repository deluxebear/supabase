package controlstore

import (
	"context"
	"database/sql"
	"errors"
)

var ErrTaskEvidenceNotFound = errors.New("task evidence not found")

// LatestSuccessfulTaskEvidence returns immutable typed evidence for the newest
// successful capability execution in a recovery domain.
func (s *Store) LatestSuccessfulTaskEvidence(ctx context.Context, targetID, capability string) ([]byte, error) {
	if s == nil || targetID == "" || capability == "" {
		return nil, errors.New("target and capability are required")
	}
	query := `SELECT r.evidence_json
FROM task_results r
JOIN task_outbox o ON o.task_id=r.task_id
JOIN jobs j ON j.id=o.job_id
WHERE j.target_id=? AND o.capability=? AND r.succeeded=1
ORDER BY r.received_at_ms DESC, r.task_id DESC LIMIT 1`
	if s.dialect == Postgres {
		query = `SELECT r.evidence_json::text
FROM task_results r
JOIN task_outbox o ON o.task_id=r.task_id
JOIN jobs j ON j.id=o.job_id
WHERE j.target_id=$1 AND o.capability=$2 AND r.succeeded=true
ORDER BY r.received_at_ms DESC, r.task_id DESC LIMIT 1`
	}
	var evidence []byte
	if err := s.db.QueryRowContext(ctx, query, targetID, capability).Scan(&evidence); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrTaskEvidenceNotFound
		}
		return nil, err
	}
	return append([]byte(nil), evidence...), nil
}
