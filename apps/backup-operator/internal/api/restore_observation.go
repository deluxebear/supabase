package api

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/recoverability"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
	"github.com/supabase/supabase/apps/backup-operator/internal/writefence"
)

type WALObservationSource interface {
	ObserveWAL(context.Context, controlstore.BackupManifestRecord) (recoverability.Observation, error)
}
type FenceCapabilitySource interface {
	ID() string
	Capabilities(context.Context, contracts.TargetRef) (contracts.Evidence, error)
}
type RepositoryObservation struct {
	Revision                      string
	RequiredBytes, AvailableBytes int64
	Destination                   string
}
type RepositoryObservationSource interface {
	ObserveRepository(context.Context, string) (RepositoryObservation, error)
}
type ManifestSource interface {
	ListBackupManifests(context.Context, string) ([]controlstore.BackupManifestRecord, error)
}

// CompositeRestoreObservationSource derives every destructive safety input from
// server-owned providers. The HTTP request supplies only the requested time.
type CompositeRestoreObservationSource struct {
	Manifests      ManifestSource
	WAL            WALObservationSource
	Topology       contracts.TopologyProvider
	Fence          FenceCapabilitySource
	Repository     RepositoryObservationSource
	ProjectID      func(string) string
	BackupProvider string
	TTL            time.Duration
	Now            func() time.Time
}

func (s CompositeRestoreObservationSource) Observe(ctx context.Context, clusterID string, target time.Time) (restoreplan.Request, error) {
	if s.Manifests == nil || s.WAL == nil || s.Topology == nil || s.Fence == nil || s.Repository == nil {
		return restoreplan.Request{}, errors.New("restore observation providers are incomplete")
	}
	now := time.Now().UTC()
	if s.Now != nil {
		now = s.Now().UTC()
	}
	project := clusterID
	if s.ProjectID != nil {
		project = s.ProjectID(clusterID)
	}
	ref := contracts.TargetRef{ProjectID: project, TargetID: clusterID}
	topology, err := s.Topology.Observe(ctx, ref)
	if err != nil {
		return restoreplan.Request{}, fmt.Errorf("observe topology: %w", err)
	}
	if err := topology.ValidateForDestructive(now); err != nil {
		return restoreplan.Request{}, err
	}
	fence, err := s.Fence.Capabilities(ctx, ref)
	if err != nil {
		return restoreplan.Request{}, fmt.Errorf("observe write fence: %w", err)
	}
	if err := fence.Validate(now); err != nil {
		return restoreplan.Request{}, err
	}
	fenceRevision := fence.Facts["config_revision"]
	fenceEntryPoints := make(map[string]string, len(writefence.RequiredEntryPoints))
	for _, entry := range writefence.RequiredEntryPoints {
		observation := fence.Facts["entrypoint."+string(entry)+".observation"]
		if observation == "" {
			return restoreplan.Request{}, fmt.Errorf("write fence entry point %s is not verifiable", entry)
		}
		fenceEntryPoints[string(entry)] = observation
	}
	if fenceRevision == "" || fence.ObservationID == "" {
		return restoreplan.Request{}, errors.New("write fence observation revision is incomplete")
	}
	manifests, err := s.Manifests.ListBackupManifests(ctx, clusterID)
	if err != nil {
		return restoreplan.Request{}, err
	}
	var candidates []restoreplan.BackupCandidate
	var repositoryID string
	var repositoryFingerprint string
	for _, manifest := range manifests {
		observation, err := s.WAL.ObserveWAL(ctx, manifest)
		if err != nil {
			continue
		}
		window := recoverability.Evaluate(observation)
		if window.Confidence == recoverability.Unknown || window.Until.Before(target) || observation.Backup.Stanza == "" || observation.Backup.Label != manifest.BackupLabel {
			continue
		}
		until := window.Until
		backupProvider := s.BackupProvider
		if backupProvider == "" {
			backupProvider = "pgbackrest"
		}
		candidate := restoreplan.BackupCandidate{ID: manifest.ProviderJobID, Label: observation.Backup.Label, Identity: contracts.BackupIdentity{ProviderID: backupProvider, RepositoryID: manifest.RepositoryID, Stanza: observation.Backup.Stanza, SystemIdentifier: fmt.Sprint(observation.Backup.DatabaseSystemID), DatabaseHistory: fmt.Sprint(observation.Backup.DatabaseHistoryID)}, StartedAt: observation.Backup.StartedAt, StoppedAt: observation.Backup.CompletedAt, RecoverableUntil: &until}
		if window.Confidence == recoverability.DrillVerified {
			drill := observation.Drill.CompletedAt
			candidate.LastDrillAt = &drill
		}
		candidates = append(candidates, candidate)
		repositoryID = manifest.RepositoryID
		repositoryFingerprint = window.Repository.Fingerprint
	}
	if len(candidates) == 0 {
		return restoreplan.Request{}, recoverabilityError(target)
	}
	repository, err := s.Repository.ObserveRepository(ctx, repositoryID)
	if err != nil {
		return restoreplan.Request{}, fmt.Errorf("observe repository: %w", err)
	}
	if repository.Revision == "" || repository.RequiredBytes <= 0 || repository.AvailableBytes < repository.RequiredBytes || repository.Destination == "" {
		return restoreplan.Request{}, errors.New("repository revision or capacity observation is incomplete")
	}
	ttl := s.TTL
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	backupProvider := s.BackupProvider
	if backupProvider == "" {
		backupProvider = "pgbackrest"
	}
	return restoreplan.Request{Target: ref, RestoreTarget: target, Candidates: candidates, Topology: topology, FenceProvider: s.Fence.ID(), FenceObservation: fence.ObservationID, FenceRevision: fenceRevision, FenceEntryPoints: fenceEntryPoints, BackupProvider: backupProvider, RepositoryRevision: repository.Revision, RepositoryFingerprint: repositoryFingerprint, Capacity: restoreplan.CapacityImpact{RequiredBytes: repository.RequiredBytes, AvailableBytes: repository.AvailableBytes, Destination: repository.Destination}, TTL: ttl, Now: now}, nil
}

func recoverabilityError(target time.Time) error {
	return fmt.Errorf("WAL gap or incomplete server-observed coverage through %s", target.UTC().Format(time.RFC3339))
}
