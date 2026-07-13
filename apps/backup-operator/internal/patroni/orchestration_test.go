package patroni

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

func TestClusterRecoveryAsyncAndSyncModes(t *testing.T) {
	for _, syncMode := range []bool{false, true} {
		t.Run(map[bool]string{false: "async", true: "sync"}[syncMode], func(t *testing.T) {
			now := time.Unix(1_700_000_000, 0)
			provider := testProvider(now)
			api := provider.API.(*fakeAPI)
			api.config.SynchronousMode = syncMode
			api.config.SynchronousModeStrict = syncMode
			runtime := &chaosRuntime{api: api, timeline: 4, systemID: "sys"}
			workflow := ClusterRecovery{Provider: provider, Runtime: runtime, Fence: patroniFence{now: now}, Synchronous: api, MaxLagBytes: 1024, Now: func() time.Time { return now }}
			evidence, err := workflow.Execute(context.Background(), patroniPlan(now), contracts.FenceHandle{ID: "fence"})
			if err != nil {
				t.Fatal(err)
			}
			if evidence.Facts["timeline"] != "4" || api.config.Paused || !provider.DCS.(*fakeDCS).lockExpired || !provider.DCS.(*fakeDCS).reconciled {
				t.Fatalf("recovery did not restore control state: evidence=%+v config=%+v", evidence, api.config)
			}
			if !runtime.admissionRelaxed || !runtime.admissionRestored {
				t.Fatalf("leader admission override was not restored: %+v", runtime)
			}
			for _, standby := range []string{"node2", "node3"} {
				if !runtime.fresh[standby] {
					t.Fatalf("standby %s was not freshly rebuilt", standby)
				}
			}
			if syncMode && (!api.config.SynchronousMode || !api.config.SynchronousModeStrict) {
				t.Fatal("synchronous replication policy was not restored")
			}
		})
	}
}

func TestClusterRecoveryFailsClosedForDualPrimaryAndDCSOutage(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	for name, breakCluster := range map[string]func(*Provider){
		"dual-primary": func(provider *Provider) { provider.API.(*fakeAPI).cluster.Members[1].Role = "leader" },
		"dcs-outage":   func(provider *Provider) { provider.DCS.(*fakeDCS).state.Healthy = false },
	} {
		t.Run(name, func(t *testing.T) {
			provider := testProvider(now)
			breakCluster(provider)
			api := provider.API.(*fakeAPI)
			workflow := ClusterRecovery{Provider: provider, Runtime: &chaosRuntime{api: api, timeline: 4, systemID: "sys"}, Fence: patroniFence{now: now}, Synchronous: api, MaxLagBytes: 1, Now: func() time.Time { return now }}
			if _, err := workflow.Execute(context.Background(), patroniPlan(now), contracts.FenceHandle{ID: "fence"}); err == nil {
				t.Fatal("unsafe topology accepted")
			}
			if api.config.Paused {
				t.Fatal("workflow mutated Patroni before initial safety assessment")
			}
		})
	}
}

func TestClusterRecoveryFailureLeavesPatroniPausedAndFenced(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	provider := testProvider(now)
	api := provider.API.(*fakeAPI)
	runtime := &chaosRuntime{api: api, timeline: 4, systemID: "sys", freshErr: errors.New("standby disk failure")}
	workflow := ClusterRecovery{Provider: provider, Runtime: runtime, Fence: patroniFence{now: now}, Synchronous: api, MaxLagBytes: 1, Now: func() time.Time { return now }}
	if _, err := workflow.Execute(context.Background(), patroniPlan(now), contracts.FenceHandle{ID: "fence"}); err == nil || !api.config.Paused {
		t.Fatalf("standby failure did not fail closed: err=%v paused=%v", err, api.config.Paused)
	}
}

func TestPatroniPauseNeverSubstitutesForWriteFence(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	provider := testProvider(now)
	api := provider.API.(*fakeAPI)
	workflow := ClusterRecovery{Provider: provider, Runtime: &chaosRuntime{api: api, timeline: 4, systemID: "sys"}, Fence: patroniFence{now: now, incomplete: true}, Synchronous: api, MaxLagBytes: 1, Now: func() time.Time { return now }}
	_, err := workflow.Execute(context.Background(), patroniPlan(now), contracts.FenceHandle{ID: "fence"})
	if err == nil || !strings.Contains(err.Error(), "cannot replace") || api.config.Paused {
		t.Fatalf("incomplete fence handling: err=%v paused=%v", err, api.config.Paused)
	}
}

type chaosRuntime struct {
	api               *fakeAPI
	timeline          uint64
	systemID          string
	fresh             map[string]bool
	freshErr          error
	admissionRelaxed  bool
	admissionRestored bool
}

func (r *chaosRuntime) StopPatroni(context.Context, string) error  { return nil }
func (r *chaosRuntime) StopPostgres(context.Context, string) error { return nil }
func (r *chaosRuntime) RestorePrimary(context.Context, string, contracts.RecoveryPlan) (RecoveredPrimary, error) {
	return RecoveredPrimary{SystemIdentifier: r.systemID, Timeline: r.timeline, QuarantineRef: "rollback-token"}, nil
}
func (r *chaosRuntime) StartPostgres(context.Context, string, bool) error { return nil }
func (r *chaosRuntime) ValidatePrimary(context.Context, string, contracts.RecoveryPlan) error {
	return nil
}
func (r *chaosRuntime) VerifyPromotedDataDir(context.Context, string) error { return nil }
func (r *chaosRuntime) StartPatroni(_ context.Context, node string) error {
	for index := range r.api.cluster.Members {
		if r.api.cluster.Members[index].Name == node {
			r.api.cluster.Members[index].Timeline = r.timeline
			r.api.cluster.Members[index].State = "running"
		}
	}
	return nil
}
func (r *chaosRuntime) RelaxLeaderAdmission(context.Context, string) (LeaderAdmissionState, error) {
	r.admissionRelaxed = true
	return LeaderAdmissionState{MaximumLagBytes: 1024, Configured: true}, nil
}
func (r *chaosRuntime) RestoreLeaderAdmission(context.Context, string, LeaderAdmissionState) error {
	r.admissionRestored = true
	return nil
}
func (r *chaosRuntime) WaitPrimary(context.Context, string) error { return nil }
func (r *chaosRuntime) FreshRebuild(_ context.Context, node, _ string) error {
	if r.fresh == nil {
		r.fresh = map[string]bool{}
	}
	r.fresh[node] = true
	return r.freshErr
}
func (r *chaosRuntime) ArchiveHealthy(context.Context, string) error { return nil }

type patroniFence struct {
	now        time.Time
	incomplete bool
}

func (f patroniFence) ID() string { return "fence" }
func (f patroniFence) Engage(context.Context, contracts.TargetRef, contracts.TopologySnapshot) (contracts.FenceHandle, error) {
	return contracts.FenceHandle{}, nil
}
func (f patroniFence) Verify(context.Context, contracts.FenceHandle) (contracts.FenceEvidence, error) {
	return contracts.FenceEvidence{Evidence: contracts.Evidence{ProviderID: "fence", ObservationID: "f", ObservedAt: f.now, ValidUntil: f.now.Add(time.Minute)}, DataPlaneBlocked: true, PoolersBlocked: true, DirectLoginBlocked: !f.incomplete, ControlChannelHealthy: true}, nil
}
func (f patroniFence) Release(context.Context, contracts.FenceHandle) (contracts.Evidence, error) {
	return contracts.Evidence{}, nil
}

func patroniPlan(now time.Time) contracts.RecoveryPlan {
	provider := testProvider(now)
	snapshot, _ := provider.Observe(context.Background(), contracts.TargetRef{ProjectID: "p", TargetID: "db"})
	return contracts.RecoveryPlan{ID: "plan", Mode: contracts.RecoveryInPlace, Target: contracts.TargetRef{ProjectID: "p", TargetID: "db"}, Topology: snapshot,
		Backup: contracts.BackupIdentity{ProviderID: "pgbackrest", RepositoryID: "repo", Stanza: "main", SystemIdentifier: "sys", DatabaseHistory: "history"}, Recovery: contracts.RestoreTarget{Time: now.Add(-time.Hour)}, TargetSystemID: "sys", Destination: "/data", PlanHash: "hash", ExpiresAt: now.Add(time.Hour)}
}
