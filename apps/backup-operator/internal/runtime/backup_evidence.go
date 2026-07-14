package runtime

import (
	"context"
	"errors"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/pgbackrest"
)

func runBackupWithEvidence(ctx context.Context, client *pgbackrest.Client, stanza, kind, repositoryID string) (controlstore.BackupManifestRecord, error) {
	if err := client.RunBackup(ctx, stanza, kind); err != nil {
		return controlstore.BackupManifestRecord{}, err
	}
	infos, err := client.RunInfo(ctx, stanza)
	if err != nil {
		return controlstore.BackupManifestRecord{}, err
	}
	var latest *pgbackrest.BackupInfo
	for i := range infos {
		if infos[i].Name != stanza {
			continue
		}
		for j := range infos[i].Backups {
			backup := &infos[i].Backups[j]
			if backup.Type == kind && (latest == nil || backup.StoppedAt.After(latest.StoppedAt)) {
				latest = backup
			}
		}
	}
	if latest == nil || latest.Label == "" || latest.StoppedAt.Equal(time.Unix(0, 0)) {
		return controlstore.BackupManifestRecord{}, errors.New("completed backup is absent from pgBackRest info")
	}
	return controlstore.BackupManifestRecord{
		ProviderJobID: latest.Label,
		RepositoryID:  repositoryID,
		BackupLabel:   latest.Label,
		BackupType:    kind,
		CompletedAt:   latest.StoppedAt.UTC(),
		ManifestJSON:  "{}",
	}, nil
}
