package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/recoverability"
)

const observedInfo = `[{"archive":[{"database":{"id":1,"repo-key":1},"id":"17-1","max":"000000010000000100000049","min":"000000010000000100000046"}],"backup":[{"archive":{"start":"000000010000000100000048","stop":"000000010000000100000048"},"database":{"id":1,"repo-key":1},"error":false,"info":{"delta":676941634,"repository":{"delta":94510912,"size":94510912},"size":676941634},"label":"20261012-045400F","lsn":{"start":"1/48000028","stop":"1/4801CDF0"},"prior":null,"reference":null,"timestamp":{"start":1791780840,"stop":1791780851},"type":"full"}],"cipher":"aes-256-cbc","db":[{"id":1,"repo-key":1,"system-id":7690825307688509473,"version":"17"}],"name":"project-d","status":{"code":0,"message":"ok"}}]`

type fakeEvidence struct {
	mu         sync.Mutex
	payload    []byte
	receivedAt time.Time
}

func (f *fakeEvidence) LatestSuccessfulTaskEvidenceAt(_ context.Context, target, capability string) ([]byte, time.Time, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if target != "project-d" || capability != ObserveCapability || f.payload == nil {
		return nil, time.Time{}, controlstore.ErrTaskEvidenceNotFound
	}
	return f.payload, f.receivedAt, nil
}

func (f *fakeEvidence) set(t *testing.T, observation ClusterObservation, receivedAt time.Time) {
	t.Helper()
	payload, err := json.Marshal(observation)
	if err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.payload, f.receivedAt = payload, receivedAt
	f.mu.Unlock()
}

type fakeManifests []controlstore.BackupManifestRecord

func (f fakeManifests) ListBackupManifests(context.Context, string) ([]controlstore.BackupManifestRecord, error) {
	return f, nil
}

var observedNow = time.Unix(1791781200, 0).UTC()

func testObservation() ClusterObservation {
	return ClusterObservation{
		ClusterID: "project-d", NodeID: "project-d-db", Stanza: "project-d", ObservedAt: observedNow.Add(-10 * time.Second),
		SystemIdentifier: "7690825307688509473", Timeline: 1, ArchiveMode: "on",
		ArchiveCommand: "/usr/lib/pgbackrest/bin/pgbackrest.real --config=/etc/pgbackrest/pgbackrest.conf --stanza=project-d archive-push %p",
		WALSegmentSize: 16 << 20, PgBackRestInfo: json.RawMessage(observedInfo), DatabaseHistoryID: 1,
		ArchiveSegments: []recoverability.ArchiveSegment{
			ExplicitSegment("000000010000000100000047", time.Unix(1791780840, 0)),
			ExplicitSegment("000000010000000100000048", time.Unix(1791780851, 0)),
			ExplicitSegment("000000010000000100000049", time.Unix(1791780869, 0)),
		},
		Destination: "/var/lib/postgresql/data", AvailableBytes: 10 << 30,
	}
}

func testObservedSource(evidence *fakeEvidence) *ObservedSinglePrimary {
	return &ObservedSinglePrimary{
		Cluster: ObservedCluster{
			ProjectID: "project-d", TargetID: "project-d", NodeID: "project-d-db", Stanza: "project-d",
			RepositoryID: "fleet-backup-project-d", RepositoryFingerprint: "s3:backup-repository/fleet-backup-project-d", RepositoryRevision: "sha256:config",
			ArchiveCommand: testObservation().ArchiveCommand, FenceAdapter: "compose",
		},
		Evidence:     evidence,
		Manifests:    fakeManifests{{ProviderJobID: "20261012-045400F", PolicyID: "studio-project-d", RepositoryID: "fleet-backup-project-d", BackupLabel: "20261012-045400F", BackupType: "full", CompletedAt: time.Unix(1791780851, 0).UTC()}},
		PollInterval: time.Millisecond,
		RefreshWait:  time.Second,
		Now:          func() time.Time { return observedNow },
	}
}

func TestObservedClusterFailsClosedWithoutFreshEvidence(t *testing.T) {
	evidence := &fakeEvidence{}
	source := testObservedSource(evidence)
	target := controlstore.TargetRecord{ProjectID: "project-d", TargetID: "project-d"}
	if _, err := source.Discover(context.Background(), target); !errors.Is(err, ErrObservationUnavailable) {
		t.Fatalf("discovery without evidence: %v", err)
	}
	evidence.set(t, testObservation(), observedNow.Add(-time.Hour))
	if _, err := source.PITRCheck(context.Background(), target); !errors.Is(err, ErrObservationUnavailable) {
		t.Fatalf("PITR check with stale evidence: %v", err)
	}
	wrongNode := testObservation()
	wrongNode.NodeID = "other"
	evidence.set(t, wrongNode, observedNow)
	if _, err := source.Discover(context.Background(), target); err == nil || !strings.Contains(err.Error(), "identity") {
		t.Fatalf("evidence from another node: %v", err)
	}
}

func TestObservedClusterReportsDiscoveryPITRAndRecoverability(t *testing.T) {
	evidence := &fakeEvidence{}
	evidence.set(t, testObservation(), observedNow.Add(-time.Minute))
	source := testObservedSource(evidence)
	discovery, err := source.Discover(context.Background(), controlstore.TargetRecord{SystemIdentifier: "7690825307688509473"})
	if err != nil || discovery.Primary != "project-d-db" || len(discovery.Blockers) != 0 || discovery.RepositoryID != "fleet-backup-project-d" {
		t.Fatalf("discovery = %+v, err = %v", discovery, err)
	}
	discovery, _ = source.Discover(context.Background(), controlstore.TargetRecord{SystemIdentifier: "1"})
	if len(discovery.Blockers) != 1 {
		t.Fatalf("a different system identifier was not reported: %+v", discovery)
	}
	status, err := source.PITRCheck(context.Background(), controlstore.TargetRecord{})
	if err != nil || !status.Enabled || !status.Healthy {
		t.Fatalf("PITR status = %+v, err = %v", status, err)
	}
	foreign := testObservation()
	foreign.ArchiveCommand = "wal-g wal-push %p"
	evidence.set(t, foreign, observedNow)
	status, _ = source.PITRCheck(context.Background(), controlstore.TargetRecord{})
	if status.Enabled || len(status.Blockers) != 1 {
		t.Fatalf("a foreign archiver was reported as PITR: %+v", status)
	}
	before := testObservation()
	before.ObservedAt = time.Unix(1791780800, 0).UTC()
	evidence.set(t, before, observedNow)
	requested := 0
	source.RequestObservation = func(context.Context) error { requested++; return nil }
	if _, err := source.ObserveRecoverability(context.Background(), "project-d"); !errors.Is(err, ErrObservationUnavailable) || requested != 1 {
		t.Fatalf("an observation older than the backup was used: err = %v, requested = %d", err, requested)
	}
	evidence.set(t, testObservation(), observedNow)
	observation, err := source.ObserveRecoverability(context.Background(), "project-d")
	if err != nil {
		t.Fatal(err)
	}
	window := recoverability.Evaluate(observation)
	if window.Confidence != recoverability.Inferred || !window.Until.Equal(time.Unix(1791780869, 0).UTC()) {
		t.Fatalf("window = %+v", window)
	}
}

func TestObservedClusterRestorePlanningRequestsAFreshObservation(t *testing.T) {
	evidence := &fakeEvidence{}
	// Received a second ago: recent, but planning still asks for a new one.
	evidence.set(t, testObservation(), observedNow.Add(-time.Second))
	source := testObservedSource(evidence)
	requested := 0
	source.RequestObservation = func(context.Context) error {
		requested++
		evidence.set(t, testObservation(), observedNow)
		return nil
	}
	request, err := source.Observe(context.Background(), "project-d", time.Unix(1791780860, 0).UTC())
	if err != nil {
		t.Fatal(err)
	}
	if requested != 1 || len(request.Candidates) != 1 || request.Candidates[0].Label != "20261012-045400F" {
		t.Fatalf("requested = %d, candidates = %+v", requested, request.Candidates)
	}
	if request.Capacity.Destination != "/var/lib/postgresql/data" || request.Capacity.RequiredBytes != 676941634 || request.FenceProvider != "compose" {
		t.Fatalf("capacity or fence = %+v / %s", request.Capacity, request.FenceProvider)
	}
	requested = 0
	source.RequestObservation = func(context.Context) error { requested++; return nil }
	if _, err := source.Observe(context.Background(), "project-d", observedNow.Add(time.Second)); err == nil || requested != 1 {
		t.Fatalf("a target after the observation was planned without a new observation: err = %v, requested = %d", err, requested)
	}
	source.RequestObservation = func(context.Context) error {
		evidence.set(t, testObservation(), observedNow)
		return nil
	}
	if _, err := source.Observe(context.Background(), "project-d", time.Unix(1791781100, 0).UTC()); err == nil {
		t.Fatal("a target after the newest archived WAL was planned")
	}
	if _, err := source.Observe(context.Background(), "project-x", time.Unix(1791780860, 0).UTC()); err == nil {
		t.Fatal("another cluster was planned")
	}
}

func TestObservedClusterFollowsTimelineHistoryAfterARestore(t *testing.T) {
	evidence := &fakeEvidence{}
	observation := testObservation()
	observation.Timeline = 2
	observation.ArchiveSegments = []recoverability.ArchiveSegment{
		ExplicitSegment("000000010000000100000048", time.Unix(1791780851, 0)),
		ExplicitSegment("000000010000000100000049", time.Unix(1791780869, 0)),
		ExplicitSegment("000000020000000100000049", time.Unix(1791781000, 0)),
		ExplicitSegment("00000002000000010000004A", time.Unix(1791781100, 0)),
	}
	evidence.set(t, observation, observedNow)
	source := testObservedSource(evidence)
	unknown, err := source.ObserveRecoverability(context.Background(), "project-d")
	if err != nil {
		t.Fatal(err)
	}
	if window := recoverability.Evaluate(unknown); window.Confidence != recoverability.Unknown {
		t.Fatalf("a timeline without history was trusted: %+v", window)
	}
	observation.ArchiveHistory = []recoverability.TimelineHistory{{Timeline: 2, Parent: 1, SwitchLSN: "1/49000100"}}
	evidence.set(t, observation, observedNow)
	known, err := source.ObserveRecoverability(context.Background(), "project-d")
	if err != nil {
		t.Fatal(err)
	}
	window := recoverability.Evaluate(known)
	if window.Confidence != recoverability.Inferred || !window.Until.Equal(time.Unix(1791781100, 0).UTC()) {
		t.Fatalf("window across the timeline switch = %+v", window)
	}
}

func TestObservedClusterPlansEachUseANewObservation(t *testing.T) {
	evidence := &fakeEvidence{}
	source := testObservedSource(evidence)
	observedAt := testObservation().ObservedAt
	source.RequestObservation = func(context.Context) error {
		observation := testObservation()
		observation.ObservedAt = observedAt
		observedAt = observedAt.Add(time.Second)
		evidence.set(t, observation, observedNow)
		return nil
	}
	target := time.Unix(1791780860, 0).UTC()
	first, err := source.Observe(context.Background(), "project-d", target)
	if err != nil {
		t.Fatal(err)
	}
	second, err := source.Observe(context.Background(), "project-d", target)
	if err != nil {
		t.Fatal(err)
	}
	// The topology identity is stable, so execution can confirm the plan, but
	// each plan comes from its own observation and so has its own deadline.
	if first.Topology.Evidence.ObservationID != second.Topology.Evidence.ObservationID {
		t.Fatal("the topology identity changed without a topology change")
	}
	if !first.Topology.Evidence.ObservedAt.Before(second.Topology.Evidence.ObservedAt) {
		t.Fatal("the second plan reused the first plan's observation")
	}
}

type fixedRecoveries time.Time

func (f fixedRecoveries) LatestRecoveryFinishedAt(context.Context, string) (time.Time, error) {
	return time.Time(f), nil
}

func TestObservedClusterIgnoresObservationsFromBeforeARestore(t *testing.T) {
	evidence := &fakeEvidence{}
	evidence.set(t, testObservation(), observedNow.Add(-time.Minute))
	source := testObservedSource(evidence)
	source.Recoveries = fixedRecoveries(observedNow.Add(-30 * time.Second))
	requested := 0
	source.RequestObservation = func(context.Context) error { requested++; return nil }
	if _, err := source.Discover(context.Background(), controlstore.TargetRecord{}); !errors.Is(err, ErrObservationUnavailable) || requested != 1 {
		t.Fatalf("an observation from before the restore was used: err = %v, requested = %d", err, requested)
	}
	evidence.set(t, testObservation(), observedNow)
	if _, err := source.Discover(context.Background(), controlstore.TargetRecord{}); err != nil {
		t.Fatal(err)
	}
}
