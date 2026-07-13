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
		if latest, err := s.Results.Latest(ctx, clusterID); err == nil && latest.Record.CompletedAt.Add(s.MinInterval).After(now) {
			continue
		} else if err != nil && !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		targetTime := now.Add(-s.TargetLag).UTC()
		request, err := s.Source.Observe(ctx, clusterID, targetTime)
		if err != nil {
			// WAL gaps and stale repository observations fail closed here: no
			// executable drill target is emitted from incomplete evidence.
			return nil, err
		}
		candidate, err := candidateForTarget(request.Candidates, targetTime)
		if err != nil {
			return nil, err
		}
		systemID, err := strconv.ParseUint(candidate.Identity.SystemIdentifier, 10, 64)
		if err != nil || systemID == 0 {
			return nil, errors.New("server-observed backup system identifier is invalid")
		}
		historyID, err := strconv.ParseUint(candidate.Identity.DatabaseHistory, 10, 64)
		if err != nil || historyID == 0 || candidate.RecoverableUntil == nil || candidate.RecoverableUntil.Before(targetTime) {
			return nil, errors.New("server-observed backup history or WAL coverage is invalid")
		}
		repo := recoverability.RepositoryIdentity{Fingerprint: request.RepositoryFingerprint, Revision: request.RepositoryRevision}
		if repo.Fingerprint == "" || repo.Revision == "" {
			return nil, errors.New("server-observed repository identity is incomplete")
		}
		nodeID := ""
		for _, node := range request.Topology.Nodes {
			if string(node.Role) == "primary" {
				nodeID = node.NodeID
				break
			}
		}
		if request.Target.ProjectID == "" || nodeID == "" {
			return nil, errors.New("server-observed drill routing identity is incomplete")
		}
		if candidate.Label == "" {
			return nil, errors.New("server-observed backup label is incomplete")
		}
		observation := recoverability.Observation{Repository: repo, Backup: recoverability.BackupObservation{
			Label: candidate.Label, StartedAt: candidate.StartedAt.UTC(), CompletedAt: candidate.StoppedAt.UTC(),
			DatabaseSystemID: systemID, DatabaseHistoryID: historyID, RepositoryIdentity: repo,
		}}
		targets = append(targets, Target{ProjectID: request.Target.ProjectID, ClusterID: clusterID, NodeID: nodeID, TargetTime: targetTime, Observation: observation})
	}
	return targets, nil
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
