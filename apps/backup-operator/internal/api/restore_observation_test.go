package api

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/recoverability"
	"github.com/supabase/supabase/apps/backup-operator/internal/writefence"
)

type observedManifests []controlstore.BackupManifestRecord

func (m observedManifests) ListBackupManifests(context.Context, string) ([]controlstore.BackupManifestRecord, error) {
	return m, nil
}

func TestProviderRestoreSourceBuildsPlanFromNormalizedManifest(t *testing.T) {
	now := time.Date(2026, 7, 13, 12, 0, 0, 0, time.UTC)
	target := now.Add(-time.Hour)
	repo := recoverability.RepositoryIdentity{Fingerprint: "fp", Revision: "rev"}
	completed := target.Add(-time.Minute)
	wal := recoverability.Observation{Repository: repo, Backup: recoverability.BackupObservation{Label: "backup", Stanza: "main", StartedAt: completed.Add(-time.Hour), CompletedAt: completed, ArchiveStart: "000000010000000000000001", ArchiveStop: "000000010000000000000001", DatabaseSystemID: 42, DatabaseHistoryID: 7, RepositoryIdentity: repo}, Archive: recoverability.ArchiveObservation{CurrentTimeline: 1, RepositoryIdentity: repo, Segments: []recoverability.ArchiveSegment{{Name: "000000010000000000000001", RecoverableThrough: target.Add(time.Minute)}}}}
	payload, err := json.Marshal(wal)
	if err != nil {
		t.Fatal(err)
	}
	evidence := contracts.Evidence{ProviderID: "custom-postgres-kubernetes", ObservationID: "namespace/postgres", ObservedAt: now.Add(-time.Minute), ValidUntil: now.Add(time.Minute)}
	topology := contracts.TopologySnapshot{Kind: contracts.TopologyKubernetesSelfOwned, Authority: "postgres", Evidence: evidence, Nodes: []contracts.NodeObservation{{NodeID: "postgres-0", Role: contracts.RolePrimary, Reachable: true, SystemIdentifier: "42"}}}
	source := ProviderRestoreSource{Manifests: observedManifests{{ProviderJobID: "backup", RepositoryID: "repo", BackupLabel: "backup", ManifestJSON: string(payload)}}, Topology: observedTopology{topology}, Repository: observedRepository{RepositoryObservation{Revision: "rev", RequiredBytes: 10, AvailableBytes: 20, Destination: "replacement"}}, ProjectID: "project", TargetID: "database", FenceProvider: "kubernetes-workload-fence", BackupProvider: "pgbackrest"}
	request, err := source.Observe(context.Background(), "database", target)
	if err != nil {
		t.Fatal(err)
	}
	if request.Target.ProjectID != "project" || request.Topology.Evidence.ProviderID != "custom-postgres-kubernetes" || request.BackupProvider != "pgbackrest" || len(request.Candidates) != 1 {
		t.Fatalf("unexpected provider restore request: %+v", request)
	}
	if request.Candidates[0].Identity.Stanza != "main" || request.Candidates[0].Identity.Stanza == request.Candidates[0].ID {
		t.Fatalf("typed stanza was not kept distinct from backup identity: %+v", request.Candidates[0])
	}
	wal.Backup.Stanza = ""
	payload, err = json.Marshal(wal)
	if err != nil {
		t.Fatal(err)
	}
	source.Manifests = observedManifests{{ProviderJobID: "backup", RepositoryID: "repo", BackupLabel: "backup", ManifestJSON: string(payload)}}
	if _, err := source.Observe(context.Background(), "database", target); err == nil {
		t.Fatal("manifest without typed stanza was accepted")
	}
}

type observedWAL struct{ value recoverability.Observation }

func (w observedWAL) ObserveWAL(context.Context, controlstore.BackupManifestRecord) (recoverability.Observation, error) {
	return w.value, nil
}

type observedTopology struct{ value contracts.TopologySnapshot }

func (t observedTopology) ID() string { return "topology" }
func (t observedTopology) Observe(context.Context, contracts.TargetRef) (contracts.TopologySnapshot, error) {
	return t.value, nil
}
func (t observedTopology) RebuildStandbys(context.Context, contracts.TargetRef, contracts.TopologySnapshot) (contracts.Evidence, error) {
	return contracts.Evidence{}, nil
}

type observedFence struct{ evidence contracts.Evidence }

func (f observedFence) ID() string { return "fence" }
func (f observedFence) Capabilities(context.Context, contracts.TargetRef) (contracts.Evidence, error) {
	return f.evidence, nil
}

type observedRepository struct{ value RepositoryObservation }

func (r observedRepository) ObserveRepository(context.Context, string) (RepositoryObservation, error) {
	return r.value, nil
}

func TestCompositeRestoreObservationsUseOnlyTrustedProviders(t *testing.T) {
	now := time.Date(2026, 7, 13, 12, 0, 0, 0, time.UTC)
	target := now.Add(-time.Hour)
	repo := recoverability.RepositoryIdentity{Fingerprint: "fp", Revision: "rev"}
	completed := target.Add(-time.Minute)
	wal := recoverability.Observation{Repository: repo, Backup: recoverability.BackupObservation{Label: "backup", Stanza: "main", StartedAt: completed.Add(-time.Hour), CompletedAt: completed, ArchiveStart: "000000010000000000000001", ArchiveStop: "000000010000000000000001", DatabaseSystemID: 42, DatabaseHistoryID: 7, RepositoryIdentity: repo}, Archive: recoverability.ArchiveObservation{CurrentTimeline: 1, RepositoryIdentity: repo, Segments: []recoverability.ArchiveSegment{{Name: "000000010000000000000001", RecoverableThrough: target.Add(time.Minute)}}}}
	evidence := contracts.Evidence{ProviderID: "trusted", ObservationID: "obs", ObservedAt: now.Add(-time.Minute), ValidUntil: now.Add(time.Minute), Facts: map[string]string{"config_revision": "rev"}}
	for _, entry := range writefence.RequiredEntryPoints {
		evidence.Facts["entrypoint."+string(entry)+".observation"] = "obs:" + string(entry)
	}
	topology := contracts.TopologySnapshot{Kind: contracts.TopologyStaticPrimary, Authority: "trusted", Evidence: evidence, Nodes: []contracts.NodeObservation{{NodeID: "primary", Role: contracts.RolePrimary, Reachable: true, SystemIdentifier: "42"}}}
	source := CompositeRestoreObservationSource{Manifests: observedManifests{{ProviderJobID: "backup", RepositoryID: "repo", BackupLabel: "backup"}}, WAL: observedWAL{wal}, Topology: observedTopology{topology}, Fence: observedFence{evidence}, Repository: observedRepository{RepositoryObservation{Revision: "rev", RequiredBytes: 10, AvailableBytes: 20, Destination: "/restore"}}, Now: func() time.Time { return now }}
	request, err := source.Observe(context.Background(), "cluster-a", target)
	if err != nil {
		t.Fatal(err)
	}
	if request.Target.TargetID != "cluster-a" || len(request.Candidates) != 1 || request.RepositoryRevision != "rev" {
		t.Fatalf("unexpected request: %#v", request)
	}
}
