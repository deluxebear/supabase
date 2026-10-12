// Command drill-validator is the isolated validation harness for restore
// drills. The Agent runs it on a PGDATA restored into the drill workspace:
//
//	drill-validator --pgdata <dir> --target-time <RFC 3339> \
//	  --expected-system-id <id> --expected-history-id <id> \
//	  --require-read-only --require-target-data --network=disabled
//
// It starts PostgreSQL on that PGDATA with no TCP listener, archiving off, and
// read-only transactions, waits for recovery to finish, checks the system
// identifier, reads every database that accepts connections, and prints one
// JSON evidence document. Diagnostics go to <pgdata>.log next to the workspace.
//
// DRILL_VALIDATOR_USER names the role to connect as (default postgres).
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/supabase/supabase/apps/backup-operator/internal/drill"
)

const port = "55433"

type options struct {
	pgdata, expectedSystemID, expectedHistoryID, user string
	targetTime                                        time.Time
	timeout                                           time.Duration
}

func main() {
	opts, err := parse(os.Args[1:], os.Getenv)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(64)
	}
	logFile, err := os.OpenFile(opts.pgdata+".log", os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer logFile.Close()
	ctx, cancel := context.WithTimeout(context.Background(), opts.timeout)
	defer cancel()
	evidence, err := validate(ctx, opts, logFile)
	if err != nil {
		fmt.Fprintf(logFile, "validation failed: %v\n", err)
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(evidence); err != nil {
		os.Exit(1)
	}
}

func parse(args []string, getenv func(string) string) (options, error) {
	set := flag.NewFlagSet("drill-validator", flag.ContinueOnError)
	set.SetOutput(io.Discard)
	pgdata := set.String("pgdata", "", "restored PGDATA")
	target := set.String("target-time", "", "drill target time")
	systemID := set.String("expected-system-id", "", "expected database system identifier")
	historyID := set.String("expected-history-id", "", "expected pgBackRest database history")
	readOnly := set.Bool("require-read-only", false, "require read-only transactions")
	targetData := set.Bool("require-target-data", false, "require readable target data")
	network := set.String("network", "", "network exposure; must be disabled")
	if err := set.Parse(args); err != nil {
		return options{}, err
	}
	if set.NArg() != 0 || !*readOnly || !*targetData || *network != "disabled" {
		return options{}, errors.New("read-only, target data, and disabled network are required")
	}
	if !filepath.IsAbs(*pgdata) || filepath.Clean(*pgdata) != *pgdata || *systemID == "" || *historyID == "" {
		return options{}, errors.New("an absolute PGDATA and the expected identities are required")
	}
	targetTime, err := time.Parse(time.RFC3339Nano, *target)
	if err != nil {
		return options{}, fmt.Errorf("invalid target time: %w", err)
	}
	user := getenv("DRILL_VALIDATOR_USER")
	if user == "" {
		user = "postgres"
	}
	if strings.ContainsAny(user, " '\\=") {
		return options{}, errors.New("invalid DRILL_VALIDATOR_USER")
	}
	return options{pgdata: *pgdata, expectedSystemID: *systemID, expectedHistoryID: *historyID, user: user, targetTime: targetTime.UTC(), timeout: 14 * time.Minute}, nil
}

func validate(ctx context.Context, opts options, logFile *os.File) (drill.ValidationEvidence, error) {
	socket, err := os.MkdirTemp("", "drill-socket-")
	if err != nil {
		return drill.ValidationEvidence{}, err
	}
	defer os.RemoveAll(socket)
	pgctl := func(args ...string) error {
		command := exec.CommandContext(ctx, "pg_ctl", append([]string{"-D", opts.pgdata}, args...)...)
		command.Stdout, command.Stderr = logFile, logFile
		return command.Run()
	}
	settings := fmt.Sprintf("-c listen_addresses='' -c port=%s -c unix_socket_directories='%s' -c archive_mode=off -c default_transaction_read_only=on", port, socket)
	if err := pgctl("-w", "-t", "600", "-l", opts.pgdata+".postgres.log", "-o", settings, "start"); err != nil {
		return drill.ValidationEvidence{}, fmt.Errorf("start isolated PostgreSQL: %w", err)
	}
	defer func() { _ = pgctl("-m", "immediate", "-w", "stop") }()

	connect := func(database string) (*sql.DB, error) {
		return sql.Open("pgx", fmt.Sprintf("host=%s port=%s user=%s dbname=%s sslmode=disable", socket, port, opts.user, database))
	}
	db, err := connect("postgres")
	if err != nil {
		return drill.ValidationEvidence{}, err
	}
	defer db.Close()
	if err := waitForPromotion(ctx, db); err != nil {
		return drill.ValidationEvidence{}, err
	}
	var systemID, walFile, readOnly, listen string
	var replayed sql.NullTime
	if err := db.QueryRowContext(ctx, `SELECT (pg_control_system()).system_identifier::text,
  pg_walfile_name(pg_current_wal_lsn()), current_setting('transaction_read_only'),
  current_setting('listen_addresses'), pg_last_xact_replay_timestamp()`).Scan(&systemID, &walFile, &readOnly, &listen, &replayed); err != nil {
		return drill.ValidationEvidence{}, fmt.Errorf("read restored cluster identity: %w", err)
	}
	if systemID != opts.expectedSystemID {
		return drill.ValidationEvidence{}, fmt.Errorf("system identifier %s does not match the backup's %s", systemID, opts.expectedSystemID)
	}
	var timeline uint32
	if _, err := fmt.Sscanf(walFile[:8], "%08X", &timeline); err != nil || timeline == 0 {
		return drill.ValidationEvidence{}, errors.New("restored cluster timeline is unknown")
	}
	databases, err := readableDatabases(ctx, db, connect)
	if err != nil {
		return drill.ValidationEvidence{}, err
	}
	observed := opts.targetTime
	if replayed.Valid {
		observed = replayed.Time.UTC()
		if observed.After(opts.targetTime) {
			return drill.ValidationEvidence{}, fmt.Errorf("recovery replayed a transaction at %s, after the target", observed.Format(time.RFC3339Nano))
		}
	}
	fmt.Fprintf(logFile, "validated system=%s timeline=%d databases=%d replayed=%v\n", systemID, timeline, databases, replayed.Time)
	return drill.ValidationEvidence{
		DatabaseSystemID: systemID, DatabaseHistoryID: opts.expectedHistoryID, Timeline: timeline,
		ReadOnly: readOnly == "on", TargetDataVerified: databases > 0, ObservedTargetTime: observed,
		StartupMode: "isolated", NetworkExposure: map[bool]string{true: "disabled", false: "exposed"}[listen == ""],
	}, nil
}

// waitForPromotion waits until recovery to the target ends and the restored
// cluster leaves recovery.
func waitForPromotion(ctx context.Context, db *sql.DB) error {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	var lastErr error
	for {
		var recovering bool
		lastErr = db.QueryRowContext(ctx, "SELECT pg_is_in_recovery()").Scan(&recovering)
		if lastErr == nil && !recovering {
			return nil
		}
		select {
		case <-ctx.Done():
			if lastErr == nil {
				lastErr = errors.New("still in recovery")
			}
			return fmt.Errorf("restored cluster did not finish recovery: %w", lastErr)
		case <-ticker.C:
		}
	}
}

// readableDatabases reads the catalog of every database that accepts
// connections and returns how many it read.
func readableDatabases(ctx context.Context, db *sql.DB, connect func(string) (*sql.DB, error)) (int, error) {
	rows, err := db.QueryContext(ctx, "SELECT datname FROM pg_database WHERE datallowconn ORDER BY datname")
	if err != nil {
		return 0, err
	}
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return 0, err
		}
		names = append(names, name)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return 0, err
	}
	for _, name := range names {
		if strings.ContainsAny(name, " '\\=") {
			return 0, fmt.Errorf("database %q cannot be checked", name)
		}
		database, err := connect(name)
		if err != nil {
			return 0, err
		}
		var relations int
		err = database.QueryRowContext(ctx, "SELECT count(*) FROM pg_class").Scan(&relations)
		database.Close()
		if err != nil || relations == 0 {
			return 0, fmt.Errorf("read database %s: %w", name, errors.Join(err, errors.New("no relations")))
		}
	}
	return len(names), nil
}
