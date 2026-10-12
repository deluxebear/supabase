package runtime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"syscall"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/pgbackrest"
	"github.com/supabase/supabase/apps/backup-operator/internal/recoverability"
)

// ObserveCapability is the Agent task that reports a single-primary cluster's
// state. The Operator runs it on a schedule instead of probing the database
// itself, because the database runs on a stack the Operator does not share.
const ObserveCapability = "single-primary-pgbackrest.maintenance.observe"

// ClusterObservation is the typed evidence of one observe task.
type ClusterObservation struct {
	ClusterID         string                          `json:"clusterId"`
	NodeID            string                          `json:"nodeId"`
	Stanza            string                          `json:"stanza"`
	ObservedAt        time.Time                       `json:"observedAt"`
	SystemIdentifier  string                          `json:"systemIdentifier"`
	Timeline          uint32                          `json:"timeline"`
	InRecovery        bool                            `json:"inRecovery"`
	ArchiveMode       string                          `json:"archiveMode"`
	ArchiveCommand    string                          `json:"archiveCommand"`
	ArchiverFailing   bool                            `json:"archiverFailing"`
	WALSegmentSize    uint64                          `json:"walSegmentSize"`
	PgBackRestInfo    json.RawMessage                 `json:"pgbackrestInfo"`
	DatabaseHistoryID uint64                          `json:"databaseHistoryId"`
	ArchiveSegments   []recoverability.ArchiveSegment `json:"archiveSegments"`
	ArchiveTimelines  []uint32                        `json:"archiveTimelines"`
	Destination       string                          `json:"destination"`
	AvailableBytes    int64                           `json:"availableBytes"`
}

// Validate checks the identity and completeness of evidence read back from the
// control store.
func (o ClusterObservation) Validate(clusterID, nodeID, stanza string) error {
	if o.ClusterID != clusterID || o.NodeID != nodeID || o.Stanza != stanza {
		return errors.New("observation identity does not match the registered cluster")
	}
	if o.ObservedAt.IsZero() || o.SystemIdentifier == "" || o.Timeline == 0 || o.Destination == "" || !json.Valid(o.PgBackRestInfo) {
		return errors.New("observation is incomplete")
	}
	return nil
}

// ClusterObserver collects a ClusterObservation on the Agent.
type ClusterObserver struct {
	DB         *sql.DB
	PgBackRest *pgbackrest.Client
	ClusterID  string
	NodeID     string
	Stanza     string
	// PGData is the data directory. Capacity is measured on its parent, where a
	// restore also keeps the quarantined copy.
	PGData         string
	Now            func() time.Time
	AvailableBytes func(string) (int64, error)
}

func (o ClusterObserver) Observe(ctx context.Context) (ClusterObservation, error) {
	if o.DB == nil || o.PgBackRest == nil || o.ClusterID == "" || o.NodeID == "" || o.Stanza == "" || !filepath.IsAbs(o.PGData) {
		return ClusterObservation{}, errors.New("cluster observer is incomplete")
	}
	now := time.Now
	if o.Now != nil {
		now = o.Now
	}
	observation := ClusterObservation{ClusterID: o.ClusterID, NodeID: o.NodeID, Stanza: o.Stanza, ObservedAt: now().UTC(), Destination: o.PGData}
	var timeline int64
	var segmentSize int64
	err := o.DB.QueryRowContext(ctx, `SELECT
  (pg_control_system()).system_identifier::text,
  pg_is_in_recovery(),
  (pg_control_checkpoint()).timeline_id::bigint,
  current_setting('archive_mode'),
  current_setting('archive_command'),
  (SELECT setting::bigint FROM pg_settings WHERE name = 'wal_segment_size'),
  COALESCE((SELECT last_failed_time > COALESCE(last_archived_time, 'epoch'::timestamptz) FROM pg_stat_archiver), false)`).Scan(
		&observation.SystemIdentifier, &observation.InRecovery, &timeline,
		&observation.ArchiveMode, &observation.ArchiveCommand, &segmentSize, &observation.ArchiverFailing)
	if err != nil {
		return ClusterObservation{}, fmt.Errorf("observe PostgreSQL: %w", err)
	}
	if timeline <= 0 || segmentSize <= 0 {
		return ClusterObservation{}, errors.New("PostgreSQL reported an invalid timeline or WAL segment size")
	}
	observation.Timeline, observation.WALSegmentSize = uint32(timeline), uint64(segmentSize)
	raw, infos, err := o.PgBackRest.RunInfoJSON(ctx, o.Stanza)
	if err != nil {
		return ClusterObservation{}, fmt.Errorf("pgBackRest info: %w", err)
	}
	observation.PgBackRestInfo = raw
	for _, info := range infos {
		if info.Name != o.Stanza || info.DatabaseHistoryID == 0 || info.DatabaseVersion == "" {
			continue
		}
		observation.DatabaseHistoryID = info.DatabaseHistoryID
		listing, err := o.PgBackRest.RunArchiveList(ctx, o.Stanza, fmt.Sprintf("%s-%d", info.DatabaseVersion, info.DatabaseHistoryID))
		if err != nil {
			return ClusterObservation{}, fmt.Errorf("list WAL archive: %w", err)
		}
		for _, segment := range listing.Segments {
			observation.ArchiveSegments = append(observation.ArchiveSegments, ExplicitSegment(segment.Name, segment.StoredAt))
		}
		observation.ArchiveTimelines = listing.Timelines
	}
	available := o.AvailableBytes
	if available == nil {
		available = statfsAvailableBytes
	}
	if observation.AvailableBytes, err = available(filepath.Dir(o.PGData)); err != nil {
		return ClusterObservation{}, fmt.Errorf("measure restore capacity: %w", err)
	}
	return observation, nil
}

func statfsAvailableBytes(path string) (int64, error) {
	var fs syscall.Statfs_t
	if err := syscall.Statfs(path, &fs); err != nil {
		return 0, err
	}
	return int64(fs.Bavail) * int64(fs.Bsize), nil
}
