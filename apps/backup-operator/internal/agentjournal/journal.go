package agentjournal

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"time"

	"golang.org/x/sys/unix"
	_ "modernc.org/sqlite"
)

var (
	ErrDestructiveBusy = errors.New("another destructive task is active")
	ErrStaleFencing    = errors.New("stale fencing token")
	ErrOrphaned        = errors.New("orphaned task requires explicit resolution")
)

type Journal struct {
	db  *sql.DB
	now func() time.Time
}

func Open(ctx context.Context, path string) (*Journal, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	journal := &Journal{db: db, now: time.Now}
	_, err = db.ExecContext(ctx, `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS execution_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1), max_fencing_token INTEGER NOT NULL);
INSERT INTO execution_meta(singleton, max_fencing_token) VALUES(1, 0) ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS executions(
  task_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  destructive INTEGER NOT NULL,
  fencing_token INTEGER NOT NULL,
  result_json TEXT,
  started_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS progress(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS progress_stats(singleton INTEGER PRIMARY KEY CHECK(singleton=1), dropped INTEGER NOT NULL);
INSERT INTO progress_stats(singleton, dropped) VALUES(1, 0) ON CONFLICT(singleton) DO NOTHING;`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return journal, nil
}

func (j *Journal) Close() error { return j.db.Close() }

type StartDisposition string

const (
	Started          StartDisposition = "started"
	DuplicateRunning StartDisposition = "duplicate-running"
	DuplicateDone    StartDisposition = "duplicate-completed"
)

func (j *Journal) Begin(ctx context.Context, taskID, idempotencyKey string, fencingToken int64, destructive bool) (StartDisposition, error) {
	tx, err := j.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var existingState string
	err = tx.QueryRowContext(ctx, "SELECT state FROM executions WHERE task_id=? OR idempotency_key=? LIMIT 1", taskID, idempotencyKey).Scan(&existingState)
	if err == nil {
		switch existingState {
		case "running":
			return DuplicateRunning, nil
		case "completed", "failed":
			return DuplicateDone, nil
		case "orphaned":
			return "", ErrOrphaned
		}
	} else if err != sql.ErrNoRows {
		return "", err
	}
	var maxToken int64
	if err := tx.QueryRowContext(ctx, "SELECT max_fencing_token FROM execution_meta WHERE singleton=1").Scan(&maxToken); err != nil {
		return "", err
	}
	if fencingToken < maxToken {
		return "", ErrStaleFencing
	}
	if destructive {
		var count int
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM executions WHERE destructive=1 AND state IN ('running','orphaned')").Scan(&count); err != nil {
			return "", err
		}
		if count != 0 {
			return "", ErrDestructiveBusy
		}
	}
	now := j.now().UnixMilli()
	if _, err := tx.ExecContext(ctx, "UPDATE execution_meta SET max_fencing_token=? WHERE singleton=1 AND max_fencing_token < ?", fencingToken, fencingToken); err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO executions(task_id,idempotency_key,state,destructive,fencing_token,started_at_ms,updated_at_ms) VALUES(?,?,'running',?,?,?,?)", taskID, idempotencyKey, destructive, fencingToken, now, now); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return Started, nil
}

func (j *Journal) Complete(ctx context.Context, taskID, resultJSON string, succeeded bool) error {
	state := "failed"
	if succeeded {
		state = "completed"
	}
	result, err := j.db.ExecContext(ctx, "UPDATE executions SET state=?, result_json=?, updated_at_ms=? WHERE task_id=? AND state='running'", state, resultJSON, j.now().UnixMilli(), taskID)
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil || rows != 1 {
		return fmt.Errorf("task is not running: %w", err)
	}
	return nil
}

func (j *Journal) MarkRunningOrphaned(ctx context.Context) (int64, error) {
	result, err := j.db.ExecContext(ctx, "UPDATE executions SET state='orphaned', updated_at_ms=? WHERE state='running' AND destructive=1", j.now().UnixMilli())
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (j *Journal) ResolveOrphan(ctx context.Context, taskID, resultJSON string) error {
	result, err := j.db.ExecContext(ctx, "UPDATE executions SET state='failed', result_json=?, updated_at_ms=? WHERE task_id=? AND state='orphaned'", resultJSON, j.now().UnixMilli(), taskID)
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil || rows != 1 {
		return fmt.Errorf("orphan was not resolved: %w", err)
	}
	return nil
}

func (j *Journal) AppendProgress(ctx context.Context, taskID, phase, message string, maxRows int) error {
	if maxRows < 1 {
		return errors.New("progress buffer must retain at least one row")
	}
	tx, err := j.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "INSERT INTO progress(task_id,phase,message,created_at_ms) VALUES(?,?,?,?)", taskID, phase, message, j.now().UnixMilli()); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, "DELETE FROM progress WHERE sequence IN (SELECT sequence FROM progress ORDER BY sequence DESC LIMIT -1 OFFSET ?)", maxRows)
	if err != nil {
		return err
	}
	dropped, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if dropped > 0 {
		if _, err := tx.ExecContext(ctx, "UPDATE progress_stats SET dropped=dropped+? WHERE singleton=1", dropped); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (j *Journal) ProgressStats(ctx context.Context) (rows, dropped int, err error) {
	if err = j.db.QueryRowContext(ctx, "SELECT count(*) FROM progress").Scan(&rows); err != nil {
		return
	}
	err = j.db.QueryRowContext(ctx, "SELECT dropped FROM progress_stats WHERE singleton=1").Scan(&dropped)
	return
}

type FileLock struct{ file *os.File }

func AcquireFileLock(path string) (*FileLock, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		file.Close()
		return nil, ErrDestructiveBusy
	}
	return &FileLock{file: file}, nil
}

func (l *FileLock) Release() error {
	if l == nil || l.file == nil {
		return nil
	}
	if err := unix.Flock(int(l.file.Fd()), unix.LOCK_UN); err != nil {
		return err
	}
	return l.file.Close()
}
