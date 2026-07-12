package observation

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

var stanzaPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`)

type CommandRunner interface {
	Run(context.Context, string, ...string) ([]byte, error)
}

type ExecRunner struct{}

func (ExecRunner) Run(ctx context.Context, binary string, args ...string) ([]byte, error) {
	if binary == "" {
		return nil, errors.New("binary path is required")
	}
	return exec.CommandContext(ctx, binary, args...).Output()
}

type Observer struct {
	DB         *sql.DB
	Runner     CommandRunner
	BinaryPath string
	Stanza     string
	Now        func() time.Time
}

type PostgreSQLObservation struct {
	SystemIdentifier string
	InRecovery       bool
	Timeline         uint64
	ReplayLSN        string
	ReplayLagSeconds int64
	ObservedAt       time.Time
}

type PgBackRestObservation struct {
	Stanza      string
	RawInfoJSON json.RawMessage
	CheckOK     bool
	ObservedAt  time.Time
}

type Snapshot struct {
	PostgreSQL PostgreSQLObservation
	PgBackRest PgBackRestObservation
	Evidence   contracts.Evidence
}

// OperatorStatus is the read-only projection consumed by self-hosted Studio.
// The control store remains authoritative for policies, jobs, and capabilities.
type OperatorStatus struct {
	Configured    bool                  `json:"configured"`
	Policy        OperatorPolicy        `json:"policy"`
	Provider      OperatorProvider      `json:"provider"`
	Topology      OperatorTopology      `json:"topology"`
	Repository    OperatorRepository    `json:"repository"`
	Check         OperatorCheck         `json:"check"`
	LastJob       *OperatorLastJob      `json:"lastJob"`
	Capabilities  OperatorCapabilities  `json:"capabilities"`
	Compatibility OperatorCompatibility `json:"compatibility"`
	UpdatedAt     *time.Time            `json:"updatedAt"`
}

type OperatorPolicy struct {
	Enabled       bool    `json:"enabled"`
	RetentionDays *int    `json:"retentionDays"`
	Schedule      *string `json:"schedule"`
	BackupFrom    *string `json:"backupFrom"`
}

type OperatorProvider struct {
	Name    string  `json:"name"`
	Version *string `json:"version"`
}

type OperatorTopology struct {
	Kind     string  `json:"kind"`
	Primary  *string `json:"primary"`
	Standbys int     `json:"standbys"`
}

type OperatorRepository struct {
	Type     *string `json:"type"`
	Location *string `json:"location"`
}

type OperatorCheck struct {
	Status    string     `json:"status"`
	CheckedAt *time.Time `json:"checkedAt"`
	Message   *string    `json:"message"`
}

type OperatorLastJob struct {
	Type       string     `json:"type"`
	State      string     `json:"state"`
	FinishedAt *time.Time `json:"finishedAt"`
}

type OperatorCapabilities struct {
	Backup   bool     `json:"backup"`
	Restore  bool     `json:"restore"`
	Blockers []string `json:"blockers"`
}

type OperatorCompatibility struct {
	Image     *string `json:"image"`
	Supported bool    `json:"supported"`
	Blocker   *string `json:"blocker"`
}

func (o Observer) Observe(ctx context.Context) (Snapshot, error) {
	if o.DB == nil || o.Runner == nil || !stanzaPattern.MatchString(o.Stanza) {
		return Snapshot{}, errors.New("database, runner, and sanitized stanza are required")
	}
	now := time.Now
	if o.Now != nil {
		now = o.Now
	}
	observedAt := now()
	var postgres PostgreSQLObservation
	err := o.DB.QueryRowContext(ctx, `SELECT
  (pg_control_system()).system_identifier::text,
  pg_is_in_recovery(),
  (pg_control_checkpoint()).timeline_id::bigint,
  COALESCE(pg_last_wal_replay_lsn()::text, ''),
  COALESCE(EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())::bigint, 0)`).Scan(
		&postgres.SystemIdentifier,
		&postgres.InRecovery,
		&postgres.Timeline,
		&postgres.ReplayLSN,
		&postgres.ReplayLagSeconds,
	)
	if err != nil {
		return Snapshot{}, fmt.Errorf("observe PostgreSQL identity: %w", err)
	}
	postgres.ObservedAt = observedAt
	info, err := o.Runner.Run(ctx, o.BinaryPath, "--stanza="+o.Stanza, "--output=json", "info")
	if err != nil {
		return Snapshot{}, fmt.Errorf("pgBackRest info: %w", err)
	}
	if !json.Valid(info) {
		return Snapshot{}, errors.New("pgBackRest info returned invalid JSON")
	}
	_, checkErr := o.Runner.Run(ctx, o.BinaryPath, "--stanza="+o.Stanza, "check")
	snapshot := Snapshot{
		PostgreSQL: postgres,
		PgBackRest: PgBackRestObservation{Stanza: o.Stanza, RawInfoJSON: append(json.RawMessage(nil), info...), CheckOK: checkErr == nil, ObservedAt: observedAt},
		Evidence: contracts.Evidence{
			ProviderID:    "pgbackrest",
			ObservationID: fmt.Sprintf("%s-%d", o.Stanza, observedAt.UnixNano()),
			ObservedAt:    observedAt,
			ValidUntil:    observedAt.Add(30 * time.Second),
			Facts: map[string]string{
				"system_identifier": postgres.SystemIdentifier,
				"stanza":            o.Stanza,
			},
		},
	}
	return snapshot, nil
}

// PublishCompatibility updates only the existing observe-only projection.
// It is not authoritative job or policy state.
func PublishCompatibility(ctx context.Context, db *sql.DB, info json.RawMessage) error {
	if db == nil || !json.Valid(info) {
		return errors.New("database and valid pgBackRest JSON are required")
	}
	if _, err := db.ExecContext(ctx, `CREATE SCHEMA IF NOT EXISTS _supabase_platform;
CREATE TABLE IF NOT EXISTS _supabase_platform.pgbackrest_info(
  id integer PRIMARY KEY DEFAULT 1 CHECK(id = 1),
  info jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`); err != nil {
		return err
	}
	_, err := db.ExecContext(ctx, `INSERT INTO _supabase_platform.pgbackrest_info(id, info, updated_at)
VALUES(1, $1::jsonb, now())
ON CONFLICT(id) DO UPDATE SET info=excluded.info, updated_at=excluded.updated_at`, string(info))
	return err
}

// PublishOperatorStatus replaces the singleton Studio projection atomically.
// It intentionally accepts a typed value and uses a parameter for the JSON payload.
func PublishOperatorStatus(ctx context.Context, db *sql.DB, status OperatorStatus) error {
	if db == nil {
		return errors.New("database is required")
	}
	payload, err := json.Marshal(status)
	if err != nil {
		return fmt.Errorf("marshal operator status: %w", err)
	}
	if _, err := db.ExecContext(ctx, `CREATE SCHEMA IF NOT EXISTS _supabase_platform;
CREATE TABLE IF NOT EXISTS _supabase_platform.backup_operator_status(
  id integer PRIMARY KEY DEFAULT 1 CHECK(id = 1),
  status jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`); err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `INSERT INTO _supabase_platform.backup_operator_status(id, status, updated_at)
VALUES(1, $1::jsonb, now())
ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`, string(payload))
	return err
}
