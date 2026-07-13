package runtime

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	operatorapi "github.com/supabase/supabase/apps/backup-operator/internal/api"
	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/observation"
	"github.com/supabase/supabase/apps/backup-operator/internal/pgbackrest"
	"github.com/supabase/supabase/apps/backup-operator/internal/recoverability"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
	"github.com/supabase/supabase/apps/backup-operator/internal/writefence"
)

type staticTopology struct{ snapshot contracts.TopologySnapshot }

func (s staticTopology) ID() string { return "single-primary-pgbackrest" }
func (s staticTopology) Observe(context.Context, contracts.TargetRef) (contracts.TopologySnapshot, error) {
	return s.snapshot, nil
}
func (s staticTopology) RebuildStandbys(context.Context, contracts.TargetRef, contracts.TopologySnapshot) (contracts.Evidence, error) {
	return contracts.Evidence{}, contracts.ErrUnsupported
}

type staticFence struct {
	evidence contracts.Evidence
	adapter  string
}

func (s staticFence) ID() string { return s.adapter }
func (s staticFence) Capabilities(context.Context, contracts.TargetRef) (contracts.Evidence, error) {
	return s.evidence, nil
}

type staticRepository struct {
	id    string
	value operatorapi.RepositoryObservation
}

func (s staticRepository) ObserveRepository(_ context.Context, id string) (operatorapi.RepositoryObservation, error) {
	if id != s.id {
		return operatorapi.RepositoryObservation{}, errors.New("repository identity mismatch")
	}
	return s.value, nil
}

func BuildLocalRestoreSource(c SinglePrimaryConfig, snapshot observation.Snapshot, available int64, manifests operatorapi.ManifestSource) (operatorapi.RestoreObservationSource, error) {
	if manifests == nil || available <= 0 || snapshot.PostgreSQL.SystemIdentifier == "" || !snapshot.PgBackRest.CheckOK {
		return nil, errors.New("complete probed local restore inputs are required")
	}
	infos, err := pgbackrest.ParseInfo(snapshot.PgBackRest.RawInfoJSON)
	if err != nil {
		return nil, err
	}
	required := int64(0)
	for _, stanza := range infos {
		if stanza.Name == c.Stanza {
			for _, backup := range stanza.Backups {
				if backup.Size > required {
					required = backup.Size
				}
			}
		}
	}
	if required <= 0 {
		return nil, errors.New("pgBackRest info has no positive restore size")
	}
	evidence := snapshot.Evidence
	evidence.ProviderID = "single-primary-pgbackrest"
	evidence.ObservationID = fmt.Sprintf("single-primary/%s/%s/%d", c.NodeID, snapshot.PostgreSQL.SystemIdentifier, snapshot.PostgreSQL.Timeline)
	topology := contracts.TopologySnapshot{Kind: contracts.TopologyStaticPrimary, Authority: c.FenceAdapter, Evidence: evidence, Nodes: []contracts.NodeObservation{{NodeID: c.NodeID, Role: contracts.RolePrimary, Reachable: true, SystemIdentifier: snapshot.PostgreSQL.SystemIdentifier, Timeline: snapshot.PostgreSQL.Timeline}}}
	wal := POSIXWALSource{InventoryFile: c.WALInventoryFile, Info: infos, Stanza: c.Stanza}
	repo := staticRepository{id: c.RepositoryID, value: operatorapi.RepositoryObservation{Revision: c.RepositoryRevision, RequiredBytes: required, AvailableBytes: available, Destination: c.CapacityPath}}
	fenceEvidence := evidence
	fenceEvidence.ProviderID = c.FenceAdapter
	fenceEvidence.ObservationID = "write-fence-" + writefence.ConfigurationRevision(c.FenceAdapter)
	fenceEvidence.Facts = map[string]string{"config_revision": writefence.ConfigurationRevision(c.FenceAdapter)}
	for _, entry := range writefence.RequiredEntryPoints {
		fenceEvidence.Facts["entrypoint."+string(entry)+".observation"] = fenceEvidence.ObservationID + ":" + string(entry)
	}
	return operatorapi.CompositeRestoreObservationSource{Manifests: manifests, WAL: wal, Topology: staticTopology{topology}, Fence: staticFence{evidence: fenceEvidence, adapter: c.FenceAdapter}, Repository: repo, ProjectID: func(string) string { return c.ProjectID }}, nil
}

type RefreshingLocalSource struct {
	Config    SinglePrimaryConfig
	Probe     *LocalSinglePrimaryProbe
	Manifests operatorapi.ManifestSource
	Refresh   func(context.Context) (operatorapi.RestoreObservationSource, error)
	mu        sync.Mutex
}

func (s *RefreshingLocalSource) Observe(ctx context.Context, cluster string, target time.Time) (restoreplan.Request, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Refresh != nil {
		source, err := s.Refresh(ctx)
		if err != nil {
			return restoreplan.Request{}, err
		}
		return source.Observe(ctx, cluster, target)
	}
	if s.Probe == nil || s.Manifests == nil {
		return restoreplan.Request{}, errors.New("refreshing local source is incomplete")
	}
	if err := s.Probe.ProbePostgres(ctx, s.Config); err != nil {
		return restoreplan.Request{}, fmt.Errorf("refresh postgres/pgBackRest: %w", err)
	}
	if err := s.Probe.ProbePGBackRest(ctx, s.Config); err != nil {
		return restoreplan.Request{}, fmt.Errorf("refresh repository capacity: %w", err)
	}
	if err := s.Probe.ProbeFence(ctx, s.Config); err != nil {
		return restoreplan.Request{}, fmt.Errorf("refresh fence: %w", err)
	}
	source, err := BuildLocalRestoreSource(s.Config, s.Probe.snapshot, s.Probe.available, s.Manifests)
	if err != nil {
		return restoreplan.Request{}, err
	}
	return source.Observe(ctx, cluster, target)
}

// ObserveRecoverability returns the newest raw server-observed backup/WAL
// lineage. Unlike restore planning, it preserves WAL gaps as an Unknown window
// instead of filtering the observation out.
func (s *RefreshingLocalSource) ObserveRecoverability(ctx context.Context, cluster string) (recoverability.Observation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Probe == nil || s.Manifests == nil || cluster == "" {
		return recoverability.Observation{}, errors.New("refreshing recoverability source is incomplete")
	}
	if err := s.Probe.ProbePostgres(ctx, s.Config); err != nil {
		return recoverability.Observation{}, err
	}
	if err := s.Probe.ProbePGBackRest(ctx, s.Config); err != nil {
		return recoverability.Observation{}, err
	}
	infos, err := pgbackrest.ParseInfo(s.Probe.snapshot.PgBackRest.RawInfoJSON)
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
	return (POSIXWALSource{InventoryFile: s.Config.WALInventoryFile, Info: infos, Stanza: s.Config.Stanza}).ObserveWAL(ctx, latest)
}

func LocalManifestSourceFactory(c SinglePrimaryConfig, probe *LocalSinglePrimaryProbe) func(operatorapi.ManifestSource) (operatorapi.RestoreObservationSource, error) {
	return func(store operatorapi.ManifestSource) (operatorapi.RestoreObservationSource, error) {
		if probe == nil {
			return nil, fmt.Errorf("local probe is required")
		}
		return BuildLocalRestoreSource(c, probe.snapshot, probe.available, store)
	}
}
