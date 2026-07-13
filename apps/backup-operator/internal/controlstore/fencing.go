package controlstore

import (
	"context"
	"database/sql"
	"errors"
	"strings"
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
	selectToken := "SELECT fencing_token, domain_key FROM task_fencing_tokens WHERE task_id=?"
	if s.dialect == Postgres {
		selectToken = "SELECT fencing_token, domain_key FROM task_fencing_tokens WHERE task_id=$1"
	}
	var token int64
	var existingDomain string
	err = tx.QueryRowContext(ctx, selectToken, taskID).Scan(&token, &existingDomain)
	if err == nil {
		if existingDomain != domain || token <= 0 {
			return 0, errors.New("task fencing token is bound to a different recovery domain")
		}
		return token, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	upsert := `INSERT INTO fencing_counters(domain_key,current_token) VALUES(?,1)
ON CONFLICT(domain_key) DO UPDATE SET current_token=fencing_counters.current_token+1
RETURNING current_token`
	insertTask := "INSERT INTO task_fencing_tokens(task_id,domain_key,fencing_token) VALUES(?,?,?)"
	if s.dialect == Postgres {
		upsert = `INSERT INTO fencing_counters(domain_key,current_token) VALUES($1,1)
ON CONFLICT(domain_key) DO UPDATE SET current_token=fencing_counters.current_token+1
RETURNING current_token`
		insertTask = "INSERT INTO task_fencing_tokens(task_id,domain_key,fencing_token) VALUES($1,$2,$3)"
	}
	if err := tx.QueryRowContext(ctx, upsert, domain).Scan(&token); err != nil {
		return 0, err
	}
	if token <= 0 {
		return 0, errors.New("fencing counter returned a non-positive token")
	}
	if _, err := tx.ExecContext(ctx, insertTask, taskID, domain, token); err != nil {
		return 0, err
	}
	return token, nil
}
