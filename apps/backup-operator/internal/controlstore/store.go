package controlstore

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/recoverydomain"
	_ "modernc.org/sqlite"
)

//go:embed migrations/*/*.sql
var migrations embed.FS

type Dialect string

const (
	SQLite   Dialect = "sqlite"
	Postgres Dialect = "postgres"
)

type Store struct {
	db       *sql.DB
	dialect  Dialect
	identity contracts.RecoveryDomain
	now      func() time.Time
}

func OpenSQLite(ctx context.Context, path string, identity contracts.RecoveryDomain) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	store := &Store{db: db, dialect: SQLite, identity: identity, now: time.Now}
	if _, err := db.ExecContext(ctx, "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;"); err != nil {
		db.Close()
		return nil, err
	}
	if err := store.migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func OpenPostgres(ctx context.Context, dsn string, identity contracts.RecoveryDomain) (*Store, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	store := &Store{db: db, dialect: Postgres, identity: identity, now: time.Now}
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}
	if err := store.migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) RecoveryDomain(context.Context) (contracts.RecoveryDomain, error) {
	return s.identity, nil
}

func (s *Store) migrate(ctx context.Context) error {
	dir := "migrations/" + string(s.dialect)
	entries, err := fs.ReadDir(migrations, dir)
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		version, err := strconv.Atoi(strings.SplitN(entry.Name(), "_", 2)[0])
		if err != nil {
			return fmt.Errorf("migration %s: %w", entry.Name(), err)
		}
		content, err := migrations.ReadFile(dir + "/" + entry.Name())
		if err != nil {
			return err
		}
		if _, err := s.db.ExecContext(ctx, string(content)); err != nil {
			return fmt.Errorf("apply migration %s: %w", entry.Name(), err)
		}
		query := "INSERT INTO schema_migrations(version, applied_at_ms) VALUES(?, ?) ON CONFLICT(version) DO NOTHING"
		if s.dialect == Postgres {
			query = "INSERT INTO schema_migrations(version, applied_at_ms) VALUES($1, $2) ON CONFLICT(version) DO NOTHING"
		}
		if _, err := s.db.ExecContext(ctx, query, version, s.now().UnixMilli()); err != nil {
			return err
		}
	}
	return s.ensureIdentity(ctx)
}

func (s *Store) ensureIdentity(ctx context.Context) error {
	query := "INSERT INTO store_identity(singleton, system_identifier, data_domain) VALUES(1, ?, ?) ON CONFLICT(singleton) DO NOTHING"
	if s.dialect == Postgres {
		query = "INSERT INTO store_identity(singleton, system_identifier, data_domain) VALUES(1, $1, $2) ON CONFLICT(singleton) DO NOTHING"
	}
	if _, err := s.db.ExecContext(ctx, query, s.identity.SystemIdentifier, s.identity.DataDomain); err != nil {
		return err
	}
	var systemID, dataDomain string
	if err := s.db.QueryRowContext(ctx, "SELECT system_identifier, data_domain FROM store_identity WHERE singleton = 1").Scan(&systemID, &dataDomain); err != nil {
		return err
	}
	if systemID != s.identity.SystemIdentifier || dataDomain != s.identity.DataDomain {
		return errors.New("configured control-store identity differs from persisted identity")
	}
	return nil
}

func (s *Store) RegisterTarget(ctx context.Context, target contracts.TargetRef, domain contracts.RecoveryDomain) error {
	if err := recoverydomain.ValidateIndependent(
		recoverydomain.Identity{SystemIdentifier: s.identity.SystemIdentifier, DataDomain: s.identity.DataDomain},
		recoverydomain.Identity{SystemIdentifier: domain.SystemIdentifier, DataDomain: domain.DataDomain},
	); err != nil {
		return err
	}
	query := "INSERT INTO targets(project_id, target_id, system_identifier, data_domain, created_at_ms) VALUES(?, ?, ?, ?, ?) ON CONFLICT(project_id, target_id) DO UPDATE SET system_identifier=excluded.system_identifier, data_domain=excluded.data_domain"
	if s.dialect == Postgres {
		query = "INSERT INTO targets(project_id, target_id, system_identifier, data_domain, created_at_ms) VALUES($1, $2, $3, $4, $5) ON CONFLICT(project_id, target_id) DO UPDATE SET system_identifier=excluded.system_identifier, data_domain=excluded.data_domain"
	}
	_, err := s.db.ExecContext(ctx, query, target.ProjectID, target.TargetID, domain.SystemIdentifier, domain.DataDomain, s.now().UnixMilli())
	return err
}

func (s *Store) CreateOperation(ctx context.Context, operation contracts.OperationRecord) error {
	now := s.now().UnixMilli()
	query := "INSERT INTO jobs(id, project_id, target_id, type, state, idempotency_key, plan_hash, created_at_ms, updated_at_ms) VALUES(?, ?, ?, 'synthetic', 'created', ?, ?, ?, ?) ON CONFLICT(project_id, target_id, idempotency_key) DO NOTHING"
	if s.dialect == Postgres {
		query = "INSERT INTO jobs(id, project_id, target_id, type, state, idempotency_key, plan_hash, created_at_ms, updated_at_ms) VALUES($1, $2, $3, 'synthetic', 'created', $4, $5, $6, $7) ON CONFLICT(project_id, target_id, idempotency_key) DO NOTHING"
	}
	result, err := s.db.ExecContext(ctx, query, operation.ID, operation.Target.ProjectID, operation.Target.TargetID, operation.IdempotencyKey, operation.PlanHash, now, now)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return nil
	}
	stepQuery := "INSERT INTO job_steps(job_id, name, state, updated_at_ms) VALUES(?, 'dispatch', 'created', ?)"
	if s.dialect == Postgres {
		stepQuery = "INSERT INTO job_steps(job_id, name, state, updated_at_ms) VALUES($1, 'dispatch', 'created', $2)"
	}
	_, err = s.db.ExecContext(ctx, stepQuery, operation.ID, now)
	return err
}

func (s *Store) TransitionWithOutbox(ctx context.Context, transition contracts.StepTransition, task contracts.TaskEnvelope) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := s.now().UnixMilli()
	update := "UPDATE job_steps SET state=?, updated_at_ms=? WHERE job_id=? AND name=? AND state=?"
	args := []any{transition.To, now, transition.OperationID, transition.Step, transition.From}
	if s.dialect == Postgres {
		update = "UPDATE job_steps SET state=$1, updated_at_ms=$2 WHERE job_id=$3 AND name=$4 AND state=$5"
	}
	result, err := tx.ExecContext(ctx, update, args...)
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil || rows != 1 {
		return fmt.Errorf("step compare-and-swap failed: %w", err)
	}
	event := "INSERT INTO job_events(job_id, step_name, event_type, payload_json, created_at_ms) VALUES(?, ?, 'step_transition', '{}', ?)"
	outbox := "INSERT INTO task_outbox(task_id, job_id, step_name, capability, target_node_id, idempotency_key, payload, created_at_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?)"
	if s.dialect == Postgres {
		event = "INSERT INTO job_events(job_id, step_name, event_type, payload_json, created_at_ms) VALUES($1, $2, 'step_transition', '{}'::jsonb, $3)"
		outbox = "INSERT INTO task_outbox(task_id, job_id, step_name, capability, target_node_id, idempotency_key, payload, created_at_ms) VALUES($1, $2, $3, $4, $5, $6, $7, $8)"
	}
	if _, err := tx.ExecContext(ctx, event, transition.OperationID, transition.Step, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, outbox, task.TaskID, task.OperationID, transition.Step, task.Capability, task.TargetNodeID, task.IdempotencyKey, []byte("{}"), now); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) RecordTaskResult(ctx context.Context, result contracts.TaskResult) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := s.now().UnixMilli()
	insert := "INSERT INTO task_results(task_id, succeeded, evidence_json, error_code, received_at_ms) VALUES(?, ?, '{}', ?, ?) ON CONFLICT(task_id) DO NOTHING"
	update := "UPDATE task_outbox SET state='completed', delivered_at_ms=? WHERE task_id=?"
	if s.dialect == Postgres {
		insert = "INSERT INTO task_results(task_id, succeeded, evidence_json, error_code, received_at_ms) VALUES($1, $2, '{}'::jsonb, $3, $4) ON CONFLICT(task_id) DO NOTHING"
		update = "UPDATE task_outbox SET state='completed', delivered_at_ms=$1 WHERE task_id=$2"
	}
	if _, err := tx.ExecContext(ctx, insert, result.TaskID, result.Succeeded, nullString(result.ErrorCode), now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, update, now, result.TaskID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) Counts(ctx context.Context) (jobs, events, outbox, results int, err error) {
	for index, item := range []struct {
		name string
		to   *int
	}{{"jobs", &jobs}, {"job_events", &events}, {"task_outbox", &outbox}, {"task_results", &results}} {
		if err = s.db.QueryRowContext(ctx, "SELECT count(*) FROM "+item.name).Scan(item.to); err != nil {
			return 0, 0, 0, 0, fmt.Errorf("count query %d: %w", index, err)
		}
	}
	return
}

func nullString(value string) any {
	if value == "" {
		return nil
	}
	return value
}
