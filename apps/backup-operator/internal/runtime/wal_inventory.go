package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/pgbackrest"
	"github.com/supabase/supabase/apps/backup-operator/internal/recoverability"
)

type WALInventory struct {
	RepositoryFingerprint string                           `json:"repositoryFingerprint"`
	RepositoryRevision    string                           `json:"repositoryRevision"`
	DatabaseHistoryID     uint64                           `json:"databaseHistoryId"`
	CurrentTimeline       uint32                           `json:"currentTimeline"`
	Segments              []recoverability.ArchiveSegment  `json:"segments"`
	History               []recoverability.TimelineHistory `json:"history"`
	Drill                 *recoverability.DrillRecord      `json:"drill,omitempty"`
}
type POSIXWALSource struct {
	InventoryFile string
	Info          []pgbackrest.StanzaInfo
	Stanza        string
}

func (s POSIXWALSource) ObserveWAL(_ context.Context, manifest controlstore.BackupManifestRecord) (recoverability.Observation, error) {
	info, err := os.Stat(s.InventoryFile)
	if err != nil {
		return recoverability.Observation{}, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return recoverability.Observation{}, errors.New("WAL inventory must be an owner-only regular file")
	}
	payload, err := os.ReadFile(s.InventoryFile)
	if err != nil {
		return recoverability.Observation{}, err
	}
	if len(payload) == 0 {
		return recoverability.Observation{}, errors.New("WAL inventory is empty")
	}
	var inventory WALInventory
	if err := json.Unmarshal(payload, &inventory); err != nil {
		return recoverability.Observation{}, fmt.Errorf("WAL inventory contains invalid JSON: %w", err)
	}
	if inventory.RepositoryFingerprint == "" || inventory.RepositoryRevision == "" || inventory.DatabaseHistoryID == 0 || inventory.CurrentTimeline == 0 {
		return recoverability.Observation{}, errors.New("WAL inventory identity is incomplete")
	}
	var stanza *pgbackrest.StanzaInfo
	for i := range s.Info {
		if s.Info[i].Name == s.Stanza {
			stanza = &s.Info[i]
			break
		}
	}
	if stanza == nil {
		return recoverability.Observation{}, errors.New("pgBackRest stanza is absent from typed info")
	}
	var backup *pgbackrest.BackupInfo
	for i := range stanza.Backups {
		if stanza.Backups[i].Label == manifest.BackupLabel {
			backup = &stanza.Backups[i]
			break
		}
	}
	if backup == nil {
		return recoverability.Observation{}, fmt.Errorf("backup %s is absent from typed pgBackRest info", manifest.BackupLabel)
	}
	repo := recoverability.RepositoryIdentity{Fingerprint: inventory.RepositoryFingerprint, Revision: inventory.RepositoryRevision}
	return recoverability.Observation{Repository: repo, Backup: recoverability.BackupObservation{Label: backup.Label, Stanza: s.Stanza, StartedAt: backup.StartedAt.UTC(), CompletedAt: backup.StoppedAt.UTC(), ArchiveStart: backup.ArchiveStart, ArchiveStop: backup.ArchiveStop, DatabaseSystemID: stanza.SystemID, DatabaseHistoryID: inventory.DatabaseHistoryID, RepositoryIdentity: repo}, Archive: recoverability.ArchiveObservation{Segments: inventory.Segments, History: inventory.History, CurrentTimeline: inventory.CurrentTimeline, RepositoryIdentity: repo}, Drill: inventory.Drill}, nil
}

func ExplicitSegment(name string, through time.Time) recoverability.ArchiveSegment {
	return recoverability.ArchiveSegment{Name: name, RecoverableThrough: through.UTC()}
}
