package patroni

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

type SynchronousConfigurator interface {
	SetSynchronousMode(context.Context, bool, bool) error
}

type RecoveredPrimary struct {
	SystemIdentifier string
	Timeline         uint64
	QuarantineRef    string
}

type LeaderAdmissionState struct {
	MaximumLagBytes int64
	Configured      bool
}

type RecoveryRuntime interface {
	StopPatroni(context.Context, string) error
	StopPostgres(context.Context, string) error
	RestorePrimary(context.Context, string, contracts.RecoveryPlan) (RecoveredPrimary, error)
	StartPostgres(context.Context, string, bool) error
	ValidatePrimary(context.Context, string, contracts.RecoveryPlan) error
	VerifyPromotedDataDir(context.Context, string) error
	StartPatroni(context.Context, string) error
	RelaxLeaderAdmission(context.Context, string) (LeaderAdmissionState, error)
	RestoreLeaderAdmission(context.Context, string, LeaderAdmissionState) error
	WaitPrimary(context.Context, string) error
	FreshRebuild(context.Context, string, string) error
	ArchiveHealthy(context.Context, string) error
}

type ClusterRecovery struct {
	Provider    *Provider
	Runtime     RecoveryRuntime
	Fence       contracts.WriteFenceProvider
	Synchronous SynchronousConfigurator
	MaxLagBytes int64
	Now         func() time.Time
}

// Execute restores the existing primary while every Patroni process is
// stopped, validates it as isolated PostgreSQL, reconciles DCS history with a
// CAS, and performs fresh rebuilds of every standby. Patroni pause is only an
// HA-control setting; a separately verified write fence is mandatory.
func (r ClusterRecovery) Execute(ctx context.Context, plan contracts.RecoveryPlan, handle contracts.FenceHandle) (contracts.Evidence, error) {
	if r.Provider == nil || r.Runtime == nil || r.Fence == nil || r.Synchronous == nil || r.MaxLagBytes < 0 {
		return contracts.Evidence{}, errors.New("Patroni recovery dependencies are incomplete")
	}
	now := r.now()
	if err := plan.Validate(now); err != nil {
		return contracts.Evidence{}, err
	}
	fence, err := r.Fence.Verify(ctx, handle)
	if err != nil {
		return contracts.Evidence{}, fmt.Errorf("verify write fence: %w", err)
	}
	if err := fence.Validate(now); err != nil || !fence.DataPlaneBlocked || !fence.PoolersBlocked || !fence.DirectLoginBlocked || !fence.ControlChannelHealthy {
		return contracts.Evidence{}, fmt.Errorf("Patroni pause cannot replace complete write fence: %w", errors.Join(err, contracts.ErrFenceIncomplete))
	}
	before, err := r.Provider.Assess(ctx, plan.Target)
	if err != nil {
		return contracts.Evidence{}, err
	}
	if err := requireSafeAssessment(before, now, false); err != nil {
		return contracts.Evidence{}, err
	}
	primary := ""
	var standbys []string
	for _, node := range before.Snapshot.Nodes {
		if node.Role == contracts.RolePrimary {
			primary = node.NodeID
		} else {
			standbys = append(standbys, node.NodeID)
		}
	}
	if err := r.Provider.API.SetPaused(ctx, true); err != nil {
		return contracts.Evidence{}, fmt.Errorf("pause Patroni failover: %w", err)
	}
	config, err := r.Provider.API.Config(ctx)
	if err != nil || !config.Paused {
		return contracts.Evidence{}, errors.New("Patroni pause was not durably observed")
	}
	// Failures after this point deliberately leave Patroni paused and fenced.
	for _, node := range before.Snapshot.Nodes {
		if err := r.Runtime.StopPatroni(ctx, node.NodeID); err != nil {
			return contracts.Evidence{}, fmt.Errorf("stop Patroni on %s: %w", node.NodeID, err)
		}
	}
	for _, node := range before.Snapshot.Nodes {
		if err := r.Runtime.StopPostgres(ctx, node.NodeID); err != nil {
			return contracts.Evidence{}, fmt.Errorf("stop PostgreSQL on %s: %w", node.NodeID, err)
		}
	}
	// Even when the key contains the recovered primary's member name, it is
	// still attached to the stopped Patroni process's lease. Wait for natural
	// expiry; never manufacture, transfer, or delete Patroni's leader lock.
	if err := r.Provider.DCS.WaitLeaderLockExpired(ctx); err != nil {
		return contracts.Evidence{}, fmt.Errorf("wait for stale Patroni leader lease expiry: %w", err)
	}
	recovered, err := r.Runtime.RestorePrimary(ctx, primary, plan)
	if err != nil {
		return contracts.Evidence{}, fmt.Errorf("restore primary PITR: %w", err)
	}
	if recovered.SystemIdentifier != plan.TargetSystemID || recovered.Timeline == 0 || recovered.QuarantineRef == "" {
		return contracts.Evidence{}, errors.New("recovered primary identity or timeline failed postcondition")
	}
	if err := r.Runtime.StartPostgres(ctx, primary, true); err != nil {
		return contracts.Evidence{}, fmt.Errorf("start isolated primary: %w", err)
	}
	if err := r.Runtime.ValidatePrimary(ctx, primary, plan); err != nil {
		return contracts.Evidence{}, fmt.Errorf("validate isolated primary: %w", err)
	}
	if err := r.Runtime.StopPostgres(ctx, primary); err != nil {
		return contracts.Evidence{}, err
	}
	if err := r.Runtime.VerifyPromotedDataDir(ctx, primary); err != nil {
		return contracts.Evidence{}, fmt.Errorf("verify promoted primary data directory: %w", err)
	}
	if err := r.Provider.DCS.Reconcile(ctx, primary, recovered.Timeline); err != nil {
		return contracts.Evidence{}, fmt.Errorf("reconcile DCS timeline: %w", err)
	}
	if err := r.Runtime.StartPatroni(ctx, primary); err != nil {
		return contracts.Evidence{}, fmt.Errorf("start recovered primary Patroni control process: %w", err)
	}
	admissionState, err := r.Runtime.RelaxLeaderAdmission(ctx, primary)
	if err != nil {
		return contracts.Evidence{}, fmt.Errorf("relax leader admission for intentional rewind: %w", err)
	}
	admissionRestored := false
	handbackComplete := false
	defer func() {
		if !admissionRestored {
			_ = r.Runtime.RestoreLeaderAdmission(context.WithoutCancel(ctx), primary, admissionState)
		}
		if !handbackComplete {
			_ = r.Provider.API.SetPaused(context.WithoutCancel(ctx), true)
		}
	}()
	if err := r.Synchronous.SetSynchronousMode(ctx, before.Config.SynchronousMode, before.Config.SynchronousModeStrict); err != nil {
		return contracts.Evidence{}, fmt.Errorf("restore synchronous replication policy before resume: %w", err)
	}
	// The external write fence remains engaged. Resume Patroni only after DCS
	// history and synchronous policy are reconciled and isolated finite PITR
	// has completed. Patroni owns the final PostgreSQL primary process.
	if err := r.Provider.API.SetPaused(ctx, false); err != nil {
		return contracts.Evidence{}, fmt.Errorf("resume Patroni for primary handback: %w", err)
	}
	if err := r.Runtime.WaitPrimary(ctx, primary); err != nil {
		return contracts.Evidence{}, fmt.Errorf("wait recovered primary under Patroni: %w", err)
	}
	if err := r.Runtime.RestoreLeaderAdmission(ctx, primary, admissionState); err != nil {
		return contracts.Evidence{}, fmt.Errorf("restore leader admission after handback: %w", err)
	}
	admissionRestored = true
	for _, standby := range standbys {
		if err := r.Runtime.FreshRebuild(ctx, standby, primary); err != nil {
			return contracts.Evidence{}, fmt.Errorf("fresh rebuild standby %s: %w", standby, err)
		}
		if err := r.Runtime.StartPatroni(ctx, standby); err != nil {
			return contracts.Evidence{}, fmt.Errorf("start standby %s: %w", standby, err)
		}
	}
	after, err := r.Provider.Assess(ctx, plan.Target)
	if err != nil {
		return contracts.Evidence{}, err
	}
	if err := requireSafeAssessment(after, r.now(), false); err != nil {
		return contracts.Evidence{}, err
	}
	for _, node := range after.Snapshot.Nodes {
		if node.Role == contracts.RoleStandby && (node.Timeline != recovered.Timeline || node.LagBytes > r.MaxLagBytes) {
			return contracts.Evidence{}, fmt.Errorf("standby %s has stale timeline or lag", node.NodeID)
		}
	}
	if err := r.Runtime.ArchiveHealthy(ctx, primary); err != nil {
		return contracts.Evidence{}, fmt.Errorf("archive health: %w", err)
	}
	finalConfig, err := r.Provider.API.Config(ctx)
	if err != nil || finalConfig.Paused || finalConfig.SynchronousMode != before.Config.SynchronousMode || finalConfig.SynchronousModeStrict != before.Config.SynchronousModeStrict {
		return contracts.Evidence{}, errors.New("Patroni resume or synchronous policy postcondition failed")
	}
	handbackComplete = true
	observed := r.now()
	return contracts.Evidence{ProviderID: r.Provider.ID(), ObservationID: after.Snapshot.Evidence.ObservationID + "-pitr", ObservedAt: observed, ValidUntil: observed.Add(30 * time.Second), Facts: map[string]string{"primary": primary, "timeline": fmt.Sprint(recovered.Timeline), "standbys": fmt.Sprint(len(standbys)), "quarantine_ref": recovered.QuarantineRef}}, nil
}

func requireSafeAssessment(assessment Assessment, now time.Time, allowPauseOnly bool) error {
	if err := assessment.Snapshot.ValidateForDestructive(now); err != nil {
		return err
	}
	for _, blocker := range assessment.Blockers {
		if allowPauseOnly && blocker.Code == BlockerManualOpsAvailable {
			continue
		}
		return fmt.Errorf("Patroni recovery blocked by %s: %s", blocker.Code, blocker.Message)
	}
	return nil
}

func (r ClusterRecovery) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}
