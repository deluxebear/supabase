package controlstore

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	sharedfencing "github.com/supabase/supabase/apps/backup-operator/internal/shared/fencing"
)

func destructiveCapability(capability string) bool {
	for _, suffix := range []string{
		".restore.execute",
		".restore.rollback",
		".pitr.enable",
		".pitr.disable",
		".maintenance.expire",
		".maintenance.restore-drill",
	} {
		if strings.HasSuffix(capability, suffix) {
			return true
		}
	}
	return false
}

// allocateTaskFencingToken returns a durable, strictly increasing token for
// one Agent recovery domain. A task retry reuses its previously issued token.
// It must run in the same transaction that durably creates the task outbox row.
func (s *Store) allocateTaskFencingToken(ctx context.Context, tx *sql.Tx, taskID, clusterID, nodeID string) (int64, error) {
	if taskID == "" || tx == nil {
		return 0, errors.New("fencing token allocation requires a task transaction")
	}
	domain, err := DestructiveFencingDomain(clusterID, nodeID)
	if err != nil {
		return 0, err
	}
	dialect := sharedfencing.SQLite
	if s.dialect == Postgres {
		dialect = sharedfencing.Postgres
	}
	return (sharedfencing.Allocator{Dialect: dialect}).Allocate(ctx, tx, taskID, domain)
}
