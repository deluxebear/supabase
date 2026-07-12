package observation

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func TestPostgresObservationAndCompatibilityIntegration(t *testing.T) {
	dsn := os.Getenv("CONTROLSTORE_POSTGRES_TEST_DSN")
	if dsn == "" {
		t.Skip("CONTROLSTORE_POSTGRES_TEST_DSN is not set")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	runner := &fakeRunner{info: []byte(`[{"name":"supabase","backup":[],"archive":[]}]`)}
	now := time.Unix(1_700_000_000, 0)
	snapshot, err := (Observer{DB: db, Runner: runner, BinaryPath: "/usr/bin/pgbackrest", Stanza: "supabase", Now: func() time.Time { return now }}).Observe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.PostgreSQL.SystemIdentifier == "" || snapshot.PostgreSQL.InRecovery || !snapshot.PgBackRest.CheckOK {
		t.Fatalf("unexpected snapshot: %#v", snapshot)
	}
	if err := PublishCompatibility(context.Background(), db, snapshot.PgBackRest.RawInfoJSON); err != nil {
		t.Fatal(err)
	}
	var raw string
	if err := db.QueryRow("SELECT info::text FROM _supabase_platform.pgbackrest_info WHERE id=1").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if raw == "" {
		t.Fatal("compatibility projection is empty")
	}
	retention := 7
	schedule := "0 2 * * *"
	backupFrom := "standby"
	providerVersion := "2.55"
	primary := "postgres-1"
	repositoryType := "s3"
	repositoryLocation := "s3://backups/project"
	image := "deluxebear/postgres:17"
	status := OperatorStatus{
		Configured:    true,
		Policy:        OperatorPolicy{Enabled: true, RetentionDays: &retention, Schedule: &schedule, BackupFrom: &backupFrom},
		Provider:      OperatorProvider{Name: "pgBackRest", Version: &providerVersion},
		Topology:      OperatorTopology{Kind: "primary-standby", Primary: &primary, Standbys: 2},
		Repository:    OperatorRepository{Type: &repositoryType, Location: &repositoryLocation},
		Check:         OperatorCheck{Status: "healthy", CheckedAt: &now},
		Capabilities:  OperatorCapabilities{Backup: true, Restore: true, Blockers: []string{}},
		Compatibility: OperatorCompatibility{Image: &image, Supported: true},
		UpdatedAt:     &now,
	}
	if err := PublishOperatorStatus(context.Background(), db, status); err != nil {
		t.Fatal(err)
	}
	var configured bool
	if err := db.QueryRow(`SELECT (status->>'configured')::boolean
FROM _supabase_platform.backup_operator_status WHERE id=1`).Scan(&configured); err != nil {
		t.Fatal(err)
	}
	if !configured {
		t.Fatal("operator status projection was not published")
	}
}
