package writefence

import (
	"context"
	"database/sql"
	"errors"
)

// PostgresDatabaseFence uses fixed SQL only. Prepared transaction identifiers
// come from pg_prepared_xacts and are quoted by PostgreSQL itself.
type PostgresDatabaseFence struct {
	DB *sql.DB
}

func (p PostgresDatabaseFence) DrainWriters(ctx context.Context) error {
	if p.DB == nil {
		return errors.New("database is required")
	}
	_, err := p.DB.ExecContext(ctx, `SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE pid <> pg_backend_pid()
  AND backend_type = 'client backend'
  AND (xact_start IS NOT NULL OR state IS DISTINCT FROM 'idle')`)
	return err
}

func (p PostgresDatabaseFence) ResolvePreparedTransactions(ctx context.Context) error {
	if p.DB == nil {
		return errors.New("database is required")
	}
	_, err := p.DB.ExecContext(ctx, `DO $fence$
DECLARE prepared record;
BEGIN
  FOR prepared IN SELECT gid FROM pg_prepared_xacts LOOP
    EXECUTE format('ROLLBACK PREPARED %L', prepared.gid);
  END LOOP;
END
$fence$`)
	return err
}

func (p PostgresDatabaseFence) ActiveWriters(ctx context.Context) (int, error) {
	if p.DB == nil {
		return 0, errors.New("database is required")
	}
	var count int
	err := p.DB.QueryRowContext(ctx, `SELECT count(*)
FROM pg_stat_activity
WHERE pid <> pg_backend_pid()
  AND backend_type = 'client backend'
  AND (xact_start IS NOT NULL OR state IS DISTINCT FROM 'idle')`).Scan(&count)
	return count, err
}

func (p PostgresDatabaseFence) PreparedTransactions(ctx context.Context) (int, error) {
	if p.DB == nil {
		return 0, errors.New("database is required")
	}
	var count int
	err := p.DB.QueryRowContext(ctx, `SELECT count(*) FROM pg_prepared_xacts`).Scan(&count)
	return count, err
}

func (p PostgresDatabaseFence) Healthy(ctx context.Context) error {
	if p.DB == nil {
		return errors.New("database is required")
	}
	return p.DB.PingContext(ctx)
}
