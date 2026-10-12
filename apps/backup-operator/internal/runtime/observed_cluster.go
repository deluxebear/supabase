package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	operatorapi "github.com/supabase/supabase/apps/backup-operator/internal/api"
	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/pgbackrest"
	"github.com/supabase/supabase/apps/backup-operator/internal/recoverability"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
	"github.com/supabase/supabase/apps/backup-operator/internal/writefence"
)

// ErrObservationUnavailable means the Agent has not reported a usable
// observation recently enough.
var ErrObservationUnavailable = errors.New("no recent observation from the backup Agent")

// TaskEvidenceAtSource reads the newest successful typed evidence of a
// capability and when the Operator received it.
type TaskEvidenceAtSource interface {
	LatestSuccessfulTaskEvidenceAt(context.Context, string, string) ([]byte, time.Time, error)
}

// RecoveryHistory reports when a target's newest restore or rollback ended.
type RecoveryHistory interface {
	LatestRecoveryFinishedAt(context.Context, string) (time.Time, error)
}

// ObservedCluster is a single-primary cluster whose database runs next to an
// enrolled Agent rather than next to the Operator.
type ObservedCluster struct {
	ProjectID, TargetID, NodeID, Stanza string
	RepositoryID, RepositoryLocation    string
	// RepositoryFingerprint and RepositoryRevision identify the repository and
	// its configuration; a change invalidates confirmed restore plans.
	RepositoryFingerprint, RepositoryRevision string
	// ArchiveCommand is the exact command the Agent's PITR workflow installs.
	ArchiveCommand string
	FenceAdapter   string
}

func (c ObservedCluster) Validate() error {
	for name, value := range map[string]string{"project": c.ProjectID, "target": c.TargetID, "node": c.NodeID, "stanza": c.Stanza, "repository ID": c.RepositoryID, "repository fingerprint": c.RepositoryFingerprint, "repository revision": c.RepositoryRevision, "archive command": c.ArchiveCommand, "fence adapter": c.FenceAdapter} {
		if value == "" {
			return fmt.Errorf("observed cluster %s is required", name)
		}
	}
	return nil
}

// ObservedSinglePrimary serves discovery, PITR status, restore planning, and
// recoverability for one cluster from Agent observations. Missing or stale
// observations fail closed.
type ObservedSinglePrimary struct {
	Cluster   ObservedCluster
	Evidence  TaskEvidenceAtSource
	Manifests operatorapi.ManifestSource
	// Recoveries reports when the target's newest restore or rollback ended. An
	// observation from before it describes a database that no longer exists.
	Recoveries RecoveryHistory
	// RequestObservation enqueues an observe task, for restore planning when
	// the latest observation is older than RestoreMaxAge.
	RequestObservation func(context.Context) error
	// MaxAge bounds observations used for status. Default 15 minutes.
	MaxAge time.Duration
	// RestoreMaxAge bounds observations used for restore planning. Default 2 minutes.
	RestoreMaxAge time.Duration
	// RefreshWait bounds how long restore planning waits for a requested
	// observation. Default 30 seconds.
	RefreshWait  time.Duration
	PollInterval time.Duration
	Now          func() time.Time
	mu           sync.Mutex
}

func (s *ObservedSinglePrimary) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func durationOr(value, fallback time.Duration) time.Duration {
	if value > 0 {
		return value
	}
	return fallback
}

// Latest returns the newest observation received within maxAge.
func (s *ObservedSinglePrimary) Latest(ctx context.Context, maxAge time.Duration) (ClusterObservation, time.Time, error) {
	if s.Evidence == nil {
		return ClusterObservation{}, time.Time{}, errors.New("observation evidence source is not configured")
	}
	payload, receivedAt, err := s.Evidence.LatestSuccessfulTaskEvidenceAt(ctx, s.Cluster.TargetID, ObserveCapability)
	if errors.Is(err, controlstore.ErrTaskEvidenceNotFound) {
		return ClusterObservation{}, time.Time{}, ErrObservationUnavailable
	}
	if err != nil {
		return ClusterObservation{}, time.Time{}, err
	}
	var observation ClusterObservation
	if err := json.Unmarshal(payload, &observation); err != nil {
		return ClusterObservation{}, time.Time{}, errors.New("stored observation is invalid")
	}
	if err := observation.Validate(s.Cluster.TargetID, s.Cluster.NodeID, s.Cluster.Stanza); err != nil {
		return ClusterObservation{}, time.Time{}, err
	}
	if age := s.now().Sub(receivedAt); age > maxAge {
		return observation, receivedAt, fmt.Errorf("%w: the latest is %s old", ErrObservationUnavailable, age.Truncate(time.Second))
	}
	if s.Recoveries != nil {
		recoveredAt, err := s.Recoveries.LatestRecoveryFinishedAt(ctx, s.Cluster.TargetID)
		if err != nil {
			return ClusterObservation{}, time.Time{}, err
		}
		if receivedAt.Before(recoveredAt) {
			if s.RequestObservation != nil {
				if err := s.RequestObservation(ctx); err != nil {
					return ClusterObservation{}, time.Time{}, fmt.Errorf("request observation: %w", err)
				}
			}
			return observation, receivedAt, fmt.Errorf("%w: the latest predates the last restore or rollback", ErrObservationUnavailable)
		}
	}
	return observation, receivedAt, nil
}

// fresh returns an observation received after this call, requesting one and
// waiting up to RefreshWait. Restore planning never reuses an earlier one: a
// restore or rollback since then may have changed the timeline, and the
// restore target may be later than it.
func (s *ObservedSinglePrimary) fresh(ctx context.Context, notBefore time.Time) (ClusterObservation, time.Time, error) {
	if s.RequestObservation == nil {
		return ClusterObservation{}, time.Time{}, errors.New("restore planning requires on-demand observations")
	}
	requestedAt := s.now().Truncate(time.Millisecond)
	if err := s.RequestObservation(ctx); err != nil {
		return ClusterObservation{}, time.Time{}, fmt.Errorf("request observation: %w", err)
	}
	maxAge := durationOr(s.RestoreMaxAge, 2*time.Minute)
	deadline := time.NewTimer(durationOr(s.RefreshWait, 30*time.Second))
	defer deadline.Stop()
	ticker := time.NewTicker(durationOr(s.PollInterval, time.Second))
	defer ticker.Stop()
	for {
		observation, receivedAt, err := s.Latest(ctx, maxAge)
		switch {
		case err != nil && !errors.Is(err, ErrObservationUnavailable):
			return ClusterObservation{}, time.Time{}, err
		case err == nil && !receivedAt.Before(requestedAt) && !observation.ObservedAt.Before(notBefore):
			return observation, receivedAt, nil
		}
		select {
		case <-ctx.Done():
			return ClusterObservation{}, time.Time{}, ctx.Err()
		case <-deadline.C:
			return ClusterObservation{}, time.Time{}, fmt.Errorf("%w: the Agent did not report a new one in time", ErrObservationUnavailable)
		case <-ticker.C:
		}
	}
}

func (s *ObservedSinglePrimary) Discover(ctx context.Context, target controlstore.TargetRecord) (operatorapi.ClusterDiscovery, error) {
	observation, _, err := s.Latest(ctx, durationOr(s.MaxAge, 15*time.Minute))
	if err != nil {
		return operatorapi.ClusterDiscovery{}, err
	}
	discovery := operatorapi.ClusterDiscovery{Topology: string(contracts.TopologyStaticPrimary), Primary: s.Cluster.NodeID, Standbys: []string{}, RepositoryID: s.Cluster.RepositoryID, RepositoryType: "pgbackrest", RepositoryLocation: s.Cluster.RepositoryLocation, Blockers: []string{}, ObservedAt: observation.ObservedAt}
	if target.SystemIdentifier != "" && target.SystemIdentifier != observation.SystemIdentifier {
		discovery.Blockers = append(discovery.Blockers, "the database system identifier differs from the registered cluster")
	}
	if observation.InRecovery {
		discovery.Blockers = append(discovery.Blockers, "the database is in recovery")
	}
	return discovery, nil
}

func (s *ObservedSinglePrimary) PITRCheck(ctx context.Context, _ controlstore.TargetRecord) (operatorapi.PITRStatus, error) {
	observation, _, err := s.Latest(ctx, durationOr(s.MaxAge, 15*time.Minute))
	if err != nil {
		return operatorapi.PITRStatus{}, err
	}
	status := operatorapi.PITRStatus{ArchiveCommand: s.Cluster.ArchiveCommand, RepositoryID: s.Cluster.RepositoryID, Blockers: []string{}}
	status.Enabled = observation.ArchiveMode == "on" && observation.ArchiveCommand == s.Cluster.ArchiveCommand
	status.Healthy = status.Enabled && !observation.ArchiverFailing
	if observation.ArchiveMode == "on" && !status.Enabled {
		status.Blockers = append(status.Blockers, "archive_command is owned by another archiver")
	}
	if status.Enabled && observation.ArchiverFailing {
		status.Blockers = append(status.Blockers, "WAL archiving is failing")
	}
	return status, nil
}

// Observe implements restore planning (operatorapi.RestoreObservationSource).
func (s *ObservedSinglePrimary) Observe(ctx context.Context, cluster string, target time.Time) (restoreplan.Request, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cluster != s.Cluster.TargetID {
		return restoreplan.Request{}, errors.New("restore cluster does not match the observed cluster")
	}
	observation, receivedAt, err := s.fresh(ctx, target)
	if err != nil {
		return restoreplan.Request{}, err
	}
	source, err := s.restoreSource(observation, receivedAt)
	if err != nil {
		return restoreplan.Request{}, err
	}
	return source.Observe(ctx, cluster, target)
}

// ObserveRecoverability implements drill.ObservationSource for the newest
// recorded backup.
func (s *ObservedSinglePrimary) ObserveRecoverability(ctx context.Context, cluster string) (recoverability.Observation, error) {
	if cluster != s.Cluster.TargetID || s.Manifests == nil {
		return recoverability.Observation{}, errors.New("recoverability cluster does not match the observed cluster")
	}
	observation, _, err := s.Latest(ctx, durationOr(s.MaxAge, 15*time.Minute))
	if err != nil {
		return recoverability.Observation{}, err
	}
	manifests, err := s.Manifests.ListBackupManifests(ctx, cluster)
	if err != nil {
		return recoverability.Observation{}, err
	}
	if len(manifests) == 0 {
		return recoverability.Observation{}, errors.New("no backup manifest is available for recoverability projection")
	}
	latest := manifests[0]
	for _, manifest := range manifests[1:] {
		if manifest.CompletedAt.After(latest.CompletedAt) {
			latest = manifest
		}
	}
	if observation.ObservedAt.Before(latest.CompletedAt) {
		// The observation cannot contain the backup's WAL yet. Ask for a new
		// one rather than waiting for the next scheduled observation.
		if s.RequestObservation != nil {
			if err := s.RequestObservation(ctx); err != nil {
				return recoverability.Observation{}, fmt.Errorf("request observation: %w", err)
			}
		}
		return recoverability.Observation{}, fmt.Errorf("%w: the latest predates backup %s", ErrObservationUnavailable, latest.BackupLabel)
	}
	return s.walSource(observation).ObserveWAL(ctx, latest)
}

func (s *ObservedSinglePrimary) walSource(observation ClusterObservation) observedWALSource {
	return observedWALSource{observation: observation, fingerprint: s.Cluster.RepositoryFingerprint, revision: s.Cluster.RepositoryRevision}
}

func (s *ObservedSinglePrimary) restoreSource(observation ClusterObservation, receivedAt time.Time) (operatorapi.RestoreObservationSource, error) {
	if s.Manifests == nil || observation.AvailableBytes <= 0 {
		return nil, errors.New("complete observed restore inputs are required")
	}
	if observation.InRecovery {
		return nil, errors.New("the database is in recovery")
	}
	infos, err := pgbackrest.ParseInfo(observation.PgBackRestInfo)
	if err != nil {
		return nil, err
	}
	required := int64(0)
	for _, stanza := range infos {
		if stanza.Name != s.Cluster.Stanza {
			continue
		}
		for _, backup := range stanza.Backups {
			if backup.Size > required {
				required = backup.Size
			}
		}
	}
	if required <= 0 {
		return nil, errors.New("pgBackRest info has no positive restore size")
	}
	validUntil := receivedAt.Add(durationOr(s.RestoreMaxAge, 2*time.Minute))
	evidence := contracts.Evidence{ProviderID: "single-primary-pgbackrest", ObservationID: fmt.Sprintf("single-primary/%s/%s/%d", s.Cluster.NodeID, observation.SystemIdentifier, observation.Timeline), ObservedAt: observation.ObservedAt, ValidUntil: validUntil}
	topology := contracts.TopologySnapshot{Kind: contracts.TopologyStaticPrimary, Authority: s.Cluster.FenceAdapter, Evidence: evidence, Nodes: []contracts.NodeObservation{{NodeID: s.Cluster.NodeID, Role: contracts.RolePrimary, Reachable: true, SystemIdentifier: observation.SystemIdentifier, Timeline: uint64(observation.Timeline)}}}
	fenceEvidence := evidence
	fenceEvidence.ProviderID = s.Cluster.FenceAdapter
	fenceEvidence.ObservationID = "write-fence-" + writefence.ConfigurationRevision(s.Cluster.FenceAdapter)
	fenceEvidence.Facts = map[string]string{"config_revision": writefence.ConfigurationRevision(s.Cluster.FenceAdapter)}
	for _, entry := range writefence.RequiredEntryPoints {
		fenceEvidence.Facts["entrypoint."+string(entry)+".observation"] = fenceEvidence.ObservationID + ":" + string(entry)
	}
	repository := staticRepository{id: s.Cluster.RepositoryID, value: operatorapi.RepositoryObservation{Revision: s.Cluster.RepositoryRevision, RequiredBytes: required, AvailableBytes: observation.AvailableBytes, Destination: observation.Destination}}
	projectID := s.Cluster.ProjectID
	return operatorapi.CompositeRestoreObservationSource{Manifests: s.Manifests, WAL: s.walSource(observation), Topology: staticTopology{topology}, Fence: staticFence{evidence: fenceEvidence, adapter: s.Cluster.FenceAdapter}, Repository: repository, ProjectID: func(string) string { return projectID }, Now: s.Now}, nil
}

type observedWALSource struct {
	observation           ClusterObservation
	fingerprint, revision string
}

func (s observedWALSource) ObserveWAL(_ context.Context, manifest controlstore.BackupManifestRecord) (recoverability.Observation, error) {
	infos, err := pgbackrest.ParseInfo(s.observation.PgBackRestInfo)
	if err != nil {
		return recoverability.Observation{}, err
	}
	inventory := WALInventory{RepositoryFingerprint: s.fingerprint, RepositoryRevision: s.revision, DatabaseHistoryID: s.observation.DatabaseHistoryID, CurrentTimeline: s.observation.Timeline, Segments: s.observation.ArchiveSegments, History: s.observation.ArchiveHistory, WALSegmentSize: s.observation.WALSegmentSize}
	return observeInventoryWAL(inventory, infos, s.observation.Stanza, manifest)
}

// ObservedClusterRouter routes recoverability by cluster.
type ObservedClusterRouter map[string]*ObservedSinglePrimary

func (r ObservedClusterRouter) ObserveRecoverability(ctx context.Context, cluster string) (recoverability.Observation, error) {
	source := r[cluster]
	if source == nil {
		return recoverability.Observation{}, fmt.Errorf("cluster %s has no observed recoverability source", cluster)
	}
	return source.ObserveRecoverability(ctx, cluster)
}
