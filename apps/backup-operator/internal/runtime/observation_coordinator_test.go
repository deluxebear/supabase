package runtime

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

type fakeObservationJobs struct {
	active  map[string]bool
	created []controlstore.CreateJobInput
	pruned  []time.Time
	failFor string
}

func (f *fakeObservationJobs) CreateJob(_ context.Context, input controlstore.CreateJobInput) (controlstore.JobRecord, bool, error) {
	if input.TargetID == f.failFor {
		return controlstore.JobRecord{}, false, errors.New("store unavailable")
	}
	f.created = append(f.created, input)
	return controlstore.JobRecord{ID: input.ID}, true, nil
}

func (f *fakeObservationJobs) HasActiveCapabilityJob(_ context.Context, target, capability string) (bool, error) {
	return capability == ObserveCapability && f.active[target], nil
}

func (f *fakeObservationJobs) PruneCapabilityJobs(_ context.Context, capability string, before time.Time, _ int) (int, error) {
	if capability != ObserveCapability {
		return 0, errors.New("wrong capability")
	}
	f.pruned = append(f.pruned, before)
	return 0, nil
}

func TestObservationCoordinatorRequestsOncePerClusterAndPrunes(t *testing.T) {
	now := time.Unix(1_800_000_000, 0).UTC()
	jobs := &fakeObservationJobs{active: map[string]bool{"project-b": true}, failFor: "project-c"}
	coordinator := ObservationCoordinator{
		Clusters: []ObservedCluster{{ProjectID: "project-a", TargetID: "project-a", NodeID: "node-a"}, {ProjectID: "project-b", TargetID: "project-b", NodeID: "node-b"}, {ProjectID: "project-c", TargetID: "project-c", NodeID: "node-c"}},
		Jobs:     jobs, Interval: 5 * time.Minute, Retention: 24 * time.Hour,
		Now: func() time.Time { return now },
	}
	coordinator.RunOnce(context.Background())
	if len(jobs.created) != 1 {
		t.Fatalf("created = %+v; want only project-a (project-b is active, project-c fails)", jobs.created)
	}
	job := jobs.created[0]
	if job.TargetID != "project-a" || job.TargetNodeID != "node-a" || job.Capability != ObserveCapability || job.Type != "maintenance" || string(job.Payload) != `{"kind":"observe"}` {
		t.Fatalf("job = %+v", job)
	}
	if len(jobs.pruned) != 1 || !jobs.pruned[0].Equal(now.Add(-24*time.Hour)) {
		t.Fatalf("pruned = %v", jobs.pruned)
	}
	if err := (ObservationCoordinator{Jobs: jobs, Interval: time.Hour, Retention: time.Minute}).Run(context.Background()); err == nil {
		t.Fatal("retention shorter than the interval was accepted")
	}
}
