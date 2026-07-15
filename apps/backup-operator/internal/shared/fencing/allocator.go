// Package fencing contains the domain-neutral monotonic token allocator used
// by independently owned control stores. Each domain supplies its own key and
// runs allocation inside the transaction that creates its task or operation.
package fencing

import (
	"context"
	"database/sql"
	"errors"
)

type Dialect string

const (
	SQLite   Dialect = "sqlite"
	Postgres Dialect = "postgres"
)

type Transaction interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type Allocator struct{ Dialect Dialect }

func (a Allocator) Allocate(ctx context.Context, tx Transaction, taskID, domain string) (int64, error) {
	if tx == nil || taskID == "" || domain == "" {
		return 0, errors.New("fencing allocation requires a transaction, task, and domain")
	}
	selectToken := "SELECT fencing_token, domain_key FROM task_fencing_tokens WHERE task_id=?"
	upsert := `INSERT INTO fencing_counters(domain_key,current_token) VALUES(?,1)
ON CONFLICT(domain_key) DO UPDATE SET current_token=fencing_counters.current_token+1
RETURNING current_token`
	insertTask := "INSERT INTO task_fencing_tokens(task_id,domain_key,fencing_token) VALUES(?,?,?)"
	if a.Dialect == Postgres {
		selectToken = "SELECT fencing_token, domain_key FROM task_fencing_tokens WHERE task_id=$1"
		upsert = `INSERT INTO fencing_counters(domain_key,current_token) VALUES($1,1)
ON CONFLICT(domain_key) DO UPDATE SET current_token=fencing_counters.current_token+1
RETURNING current_token`
		insertTask = "INSERT INTO task_fencing_tokens(task_id,domain_key,fencing_token) VALUES($1,$2,$3)"
	} else if a.Dialect != SQLite {
		return 0, errors.New("unsupported fencing store dialect")
	}
	var token int64
	var existingDomain string
	err := tx.QueryRowContext(ctx, selectToken, taskID).Scan(&token, &existingDomain)
	if err == nil {
		if existingDomain != domain || token <= 0 {
			return 0, errors.New("task fencing token is bound to a different domain")
		}
		return token, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
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
