// seed-observation records provider output that was produced before the
// operator starts. The destructive path itself still enters through the
// authenticated API and durable outbox; this helper only supplies the same
// normalized backup/WAL evidence a production backup worker persists.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/recoverability"
)

func main() {
	dsn := flag.String("dsn", "", "SQLite control-store path")
	project := flag.String("project", "e2e-project", "project id")
	target := flag.String("target", "e2e-database", "target id")
	systemID := flag.Uint64("system-id", 0, "database system identifier")
	repository := flag.String("repository", "", "provider repository id")
	backupID := flag.String("backup-id", "", "provider backup id")
	stanza := flag.String("stanza", "", "provider stanza identity stored with the manifest")
	completedText := flag.String("completed-at", "", "backup completion time")
	recoverableText := flag.String("recoverable-until", "", "observed contiguous WAL coverage end")
	flag.Parse()
	if *stanza == "" {
		*stanza = *backupID
	}
	completed := mustTime(*completedText)
	recoverable := mustTime(*recoverableText)
	if *dsn == "" || *systemID == 0 || *repository == "" || *backupID == "" || !recoverable.After(completed) {
		log.Fatal("dsn, system-id, repository, backup-id, and ordered evidence times are required")
	}
	identity := recoverability.RepositoryIdentity{Fingerprint: "e2e:" + *repository, Revision: "e2e-observed-v1"}
	observation := recoverability.Observation{
		Repository: identity,
		Backup: recoverability.BackupObservation{
			Label: *backupID, Stanza: *stanza, StartedAt: completed.Add(-time.Minute), CompletedAt: completed,
			ArchiveStart: "000000010000000000000001", ArchiveStop: "000000010000000000000001",
			DatabaseSystemID: *systemID, DatabaseHistoryID: 1, RepositoryIdentity: identity,
		},
		Archive: recoverability.ArchiveObservation{
			Segments:        []recoverability.ArchiveSegment{{Name: "000000010000000000000001", RecoverableThrough: recoverable}},
			CurrentTimeline: 1, RepositoryIdentity: identity,
		},
	}
	payload, err := json.Marshal(observation)
	if err != nil {
		log.Fatal(err)
	}
	ctx := context.Background()
	store, err := controlstore.OpenSQLite(ctx, *dsn, contracts.RecoveryDomain{SystemIdentifier: "backup-operator-control", DataDomain: "backup-operator-state"})
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()
	if err := store.RegisterCluster(ctx, controlstore.TargetRecord{ProjectID: *project, TargetID: *target, SystemIdentifier: "database-" + *target, DataDomain: "pgdata-" + *target}); err != nil {
		log.Fatal(err)
	}
	if err := store.RegisterRepository(ctx, controlstore.RepositoryRecord{ID: *repository, Fingerprint: identity.Fingerprint, Type: "provider", Endpoint: "https://provider.invalid", EncryptedCredentials: []byte("e2e-sealed"), KeyID: "e2e-key"}); err != nil {
		log.Fatal(err)
	}
	policy := controlstore.StandardBackupPolicy(*project, *target, *repository, time.Now().UTC())
	if err := store.UpsertBackupPolicy(ctx, policy); err != nil {
		log.Fatal(err)
	}
	if err := store.RecordBackupManifest(ctx, controlstore.BackupManifestRecord{ProviderJobID: *backupID, PolicyID: policy.ID, RepositoryID: *repository, BackupLabel: *backupID, BackupType: "full", CompletedAt: completed, ManifestJSON: string(payload)}); err != nil {
		log.Fatal(err)
	}
}

func mustTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		log.Fatal(err)
	}
	return parsed.UTC()
}
