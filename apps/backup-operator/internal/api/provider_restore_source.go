package api

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/recoverability"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
	"github.com/supabase/supabase/apps/backup-operator/internal/writefence"
)

type RepositoryObservationFunc func(context.Context, string) (RepositoryObservation, error)

func (f RepositoryObservationFunc) ObserveRepository(ctx context.Context, id string) (RepositoryObservation, error) {
	return f(ctx, id)
}

// ManifestWALObservation accepts the server-owned, normalized recoverability
// observation recorded with a provider backup manifest.
type ManifestWALObservation struct{}

func (ManifestWALObservation) ObserveWAL(_ context.Context, manifest controlstore.BackupManifestRecord) (recoverability.Observation, error) {
	var observation recoverability.Observation
	if err := json.Unmarshal([]byte(manifest.ManifestJSON), &observation); err != nil {
		return observation, err
	}
	if observation.Backup.Label == "" || observation.Backup.DatabaseSystemID == 0 || observation.Backup.DatabaseHistoryID == 0 || observation.Repository.Revision == "" {
		return observation, errors.New("normalized backup/WAL observation is incomplete")
	}
	return observation, nil
}

type providerObservedFence struct {
	id       string
	topology contracts.TopologyProvider
}

func (f providerObservedFence) ID() string { return f.id }
func (f providerObservedFence) Capabilities(ctx context.Context, target contracts.TargetRef) (contracts.Evidence, error) {
	topology, err := f.topology.Observe(ctx, target)
	if err != nil {
		return contracts.Evidence{}, err
	}
	evidence := topology.Evidence
	evidence.ProviderID = f.id
	if evidence.Facts == nil {
		evidence.Facts = map[string]string{}
	}
	evidence.Facts["config_revision"] = writefence.ConfigurationRevision(f.id)
	for _, entry := range writefence.RequiredEntryPoints {
		evidence.Facts["entrypoint."+string(entry)+".observation"] = evidence.ObservationID + ":" + string(entry)
	}
	return evidence, nil
}

type ProviderRestoreSource struct {
	Manifests      ManifestSource
	Topology       contracts.TopologyProvider
	Repository     RepositoryObservationSource
	ProjectID      string
	TargetID       string
	FenceProvider  string
	BackupProvider string
	TTL            time.Duration
}

func (s ProviderRestoreSource) Observe(ctx context.Context, clusterID string, target time.Time) (restoreplan.Request, error) {
	if s.ProjectID == "" || s.TargetID == "" || clusterID != s.TargetID || s.FenceProvider == "" || s.BackupProvider == "" {
		return restoreplan.Request{}, errors.New("provider restore source target and execution providers are incomplete")
	}
	return (CompositeRestoreObservationSource{Manifests: s.Manifests, WAL: ManifestWALObservation{}, Topology: s.Topology, Fence: providerObservedFence{id: s.FenceProvider, topology: s.Topology}, Repository: s.Repository, ProjectID: func(string) string { return s.ProjectID }, BackupProvider: s.BackupProvider, TTL: s.TTL}).Observe(ctx, clusterID, target)
}

type RoutedRestoreObservationSource struct {
	Sources map[string]RestoreObservationSource
}

func (r RoutedRestoreObservationSource) Observe(ctx context.Context, clusterID string, target time.Time) (restoreplan.Request, error) {
	source := r.Sources[clusterID]
	if source == nil {
		return restoreplan.Request{}, errors.New("restore target has no configured observation source")
	}
	return source.Observe(ctx, clusterID, target)
}
