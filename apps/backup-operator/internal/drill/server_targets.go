package drill

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/recoverability"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
)

type ServerRestoreObservation interface {
	Observe(context.Context, string, time.Time) (restoreplan.Request, error)
}

// ServerObservationTargets derives drill inputs only from the same
// server-observed backup/WAL/repository path used to authorize PITR restores.
type ServerObservationTargets struct {
	Source      ServerRestoreObservation
	Results     Store
	ClusterIDs  []string
	TargetLag   time.Duration
	MinInterval time.Duration
	// BackupMinInterval lets a drill run again before MinInterval when a backup
	// newer than the last drill's exists. Zero disables that.
	BackupMinInterval time.Duration
}

func (s ServerObservationTargets) DueTargets(ctx context.Context, now time.Time) ([]Target, error) {
	if s.Source == nil || s.Results == nil || len(s.ClusterIDs) == 0 || s.TargetLag <= 0 || s.MinInterval <= 0 || now.Location() != time.UTC {
		return nil, errors.New("server drill target source requires observations, results, clusters, and positive UTC intervals")
	}
	var targets []Target
	for _, clusterID := range s.ClusterIDs {
		if clusterID == "" {
			return nil, errors.New("drill cluster cannot be empty")
		}
		latest, err := s.Results.Latest(ctx, clusterID)
		hasLatest := err == nil
		if err != nil && !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		// A drill younger than MinInterval normally suppresses the next one. It
		// is superseded once a newer backup exists, which the last drill did not
		// verify, but not more often than BackupMinInterval.
		isRecent := hasLatest && latest.Record.CompletedAt.Add(s.MinInterval).After(now)
		mayCoverNewBackup := hasLatest && s.BackupMinInterval > 0 && !latest.Record.CompletedAt.Add(s.BackupMinInterval).After(now)
		if isRecent && !mayCoverNewBackup {
			continue
		}
		target, err := s.buildTarget(ctx, clusterID, now)
		if err != nil {
			if isRecent {
				// Only the new-backup check is at stake: incomplete evidence
				// must not surface as a blocked drill while the last one is fresh.
				continue
			}
			return nil, err
		}
		if isRecent && target.Observation.Backup.Label == latest.Record.Lineage.BackupLabel {
			continue
		}
		targets = append(targets, target)
	}
	return targets, nil
}

func (s ServerObservationTargets) buildTarget(ctx context.Context, clusterID string, now time.Time) (Target, error) {
	targetTime := now.Add(-s.TargetLag).UTC()
	request, err := s.Source.Observe(ctx, clusterID, targetTime)
	if err != nil {
		// WAL gaps and stale repository observations fail closed here: no
		// executable drill target is emitted from incomplete evidence.
		return Target{}, err
	}
	candidate, err := candidateForTarget(request.Candidates, targetTime)
	if err != nil {
		return Target{}, err
	}
	systemID, err := strconv.ParseUint(candidate.Identity.SystemIdentifier, 10, 64)
	if err != nil || systemID == 0 {
		return Target{}, errors.New("server-observed backup system identifier is invalid")
	}
	historyID, err := strconv.ParseUint(candidate.Identity.DatabaseHistory, 10, 64)
	if err != nil || historyID == 0 || candidate.RecoverableUntil == nil || candidate.RecoverableUntil.Before(targetTime) {
		return Target{}, errors.New("server-observed backup history or WAL coverage is invalid")
	}
	repo := recoverability.RepositoryIdentity{Fingerprint: request.RepositoryFingerprint, Revision: request.RepositoryRevision}
	if repo.Fingerprint == "" || repo.Revision == "" {
		return Target{}, errors.New("server-observed repository identity is incomplete")
	}
	nodeID := ""
	var timeline uint32
	for _, node := range request.Topology.Nodes {
		if string(node.Role) == "primary" {
			nodeID, timeline = node.NodeID, uint32(node.Timeline)
			break
		}
	}
	if request.Target.ProjectID == "" || nodeID == "" {
		return Target{}, errors.New("server-observed drill routing identity is incomplete")
	}
	if candidate.Label == "" {
		return Target{}, errors.New("server-observed backup label is incomplete")
	}
	observation := recoverability.Observation{Repository: repo, Backup: recoverability.BackupObservation{
		Label: candidate.Label, StartedAt: candidate.StartedAt.UTC(), CompletedAt: candidate.StoppedAt.UTC(),
		DatabaseSystemID: systemID, DatabaseHistoryID: historyID, RepositoryIdentity: repo,
	}}
	return Target{ProjectID: request.Target.ProjectID, ClusterID: clusterID, NodeID: nodeID, TargetTime: targetTime, Timeline: timeline, Observation: observation}, nil
}

func candidateForTarget(candidates []restoreplan.BackupCandidate, target time.Time) (restoreplan.BackupCandidate, error) {
	var selected restoreplan.BackupCandidate
	for _, candidate := range candidates {
		if candidate.ID == "" || candidate.StoppedAt.After(target) || candidate.RecoverableUntil == nil || candidate.RecoverableUntil.Before(target) {
			continue
		}
		if selected.ID == "" || candidate.StoppedAt.After(selected.StoppedAt) {
			selected = candidate
		}
	}
	if selected.ID == "" {
		return selected, errors.New("server observations have no backup with contiguous WAL through drill target")
	}
	return selected, nil
}
