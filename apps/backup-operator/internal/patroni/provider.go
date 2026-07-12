package patroni

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

type Member struct {
	Name     string
	Role     string
	State    string
	Timeline uint64
	LagBytes int64
}

type Cluster struct {
	Members []Member
}

type Config struct {
	Paused                bool
	SynchronousMode       bool
	SynchronousModeStrict bool
}

type API interface {
	Cluster(context.Context) (Cluster, error)
	Config(context.Context) (Config, error)
	SetPaused(context.Context, bool) error
}

type DCSState struct {
	Healthy    bool
	Leader     string
	HistoryID  string
	Revision   string
	ObservedAt time.Time
}

type DCS interface {
	Observe(context.Context) (DCSState, error)
	Reconcile(context.Context, string, uint64) error
}

type NodeIdentity struct {
	SystemIdentifier string
	Reachable        bool
	WatchdogHealthy  bool
}

type NodeInspector interface {
	Identity(context.Context, string) (NodeIdentity, error)
}

type BlockerCode string

const (
	BlockerDCSUnavailable     BlockerCode = "dcs-unavailable"
	BlockerLeaderMismatch     BlockerCode = "leader-mismatch"
	BlockerNodeUnreachable    BlockerCode = "node-unreachable"
	BlockerWatchdogUnhealthy  BlockerCode = "watchdog-unhealthy"
	BlockerManualOpsAvailable BlockerCode = "manual-operations-remain-available"
)

type Blocker struct {
	Code    BlockerCode
	Message string
}

type Assessment struct {
	Snapshot contracts.TopologySnapshot
	Config   Config
	DCS      DCSState
	Blockers []Blocker
}

type Provider struct {
	ProviderID string
	API        API
	DCS        DCS
	Nodes      NodeInspector
	Rebuilder  StandbyRebuilder
	Now        func() time.Time
}

func (p *Provider) ID() string { return p.ProviderID }

func (p *Provider) Assess(ctx context.Context, _ contracts.TargetRef) (Assessment, error) {
	if p.ProviderID == "" || p.API == nil || p.DCS == nil || p.Nodes == nil {
		return Assessment{}, errors.New("Patroni provider is incomplete")
	}
	cluster, err := p.API.Cluster(ctx)
	if err != nil {
		return Assessment{}, fmt.Errorf("Patroni cluster: %w", err)
	}
	config, err := p.API.Config(ctx)
	if err != nil {
		return Assessment{}, fmt.Errorf("Patroni config: %w", err)
	}
	dcs, err := p.DCS.Observe(ctx)
	if err != nil {
		return Assessment{}, fmt.Errorf("DCS state: %w", err)
	}
	now := p.now()
	assessment := Assessment{Config: config, DCS: dcs}
	assessment.Snapshot = contracts.TopologySnapshot{
		Kind: contracts.TopologyPatroni, Authority: "patroni-dcs", ControllerOwner: dcs.Leader,
		Evidence: contracts.Evidence{ProviderID: p.ProviderID, ObservationID: dcs.Revision, ObservedAt: now, ValidUntil: now.Add(30 * time.Second), Facts: map[string]string{
			"dcs_leader": dcs.Leader, "dcs_history": dcs.HistoryID, "paused": strconv.FormatBool(config.Paused),
			"synchronous_mode": strconv.FormatBool(config.SynchronousMode), "synchronous_mode_strict": strconv.FormatBool(config.SynchronousModeStrict),
		}},
	}
	if !dcs.Healthy {
		assessment.Blockers = append(assessment.Blockers, Blocker{Code: BlockerDCSUnavailable, Message: "DCS is unavailable or stale"})
	}
	leaders := 0
	for _, member := range cluster.Members {
		identity, identityErr := p.Nodes.Identity(ctx, member.Name)
		if identityErr != nil {
			identity.Reachable = false
		}
		role := contracts.RoleStandby
		if member.Role == "leader" || member.Role == "primary" {
			role = contracts.RolePrimary
			leaders++
		}
		assessment.Snapshot.Nodes = append(assessment.Snapshot.Nodes, contracts.NodeObservation{
			NodeID: member.Name, Role: role, Reachable: identity.Reachable && member.State == "running", SystemIdentifier: identity.SystemIdentifier, Timeline: member.Timeline, LagBytes: member.LagBytes,
		})
		if !identity.Reachable {
			assessment.Blockers = append(assessment.Blockers, Blocker{Code: BlockerNodeUnreachable, Message: member.Name + " is unreachable"})
		}
		if !identity.WatchdogHealthy {
			assessment.Blockers = append(assessment.Blockers, Blocker{Code: BlockerWatchdogUnhealthy, Message: member.Name + " watchdog is not healthy"})
		}
		if role == contracts.RolePrimary && dcs.Leader != "" && dcs.Leader != member.Name {
			assessment.Blockers = append(assessment.Blockers, Blocker{Code: BlockerLeaderMismatch, Message: "Patroni role and DCS leader disagree"})
		}
	}
	if config.Paused {
		assessment.Blockers = append(assessment.Blockers, Blocker{Code: BlockerManualOpsAvailable, Message: "Patroni pause does not block manual promotion or switchover"})
	}
	if leaders != 1 {
		assessment.Blockers = append(assessment.Blockers, Blocker{Code: BlockerLeaderMismatch, Message: fmt.Sprintf("expected one leader, got %d", leaders)})
	}
	return assessment, nil
}

func (p *Provider) Observe(ctx context.Context, target contracts.TargetRef) (contracts.TopologySnapshot, error) {
	assessment, err := p.Assess(ctx, target)
	return assessment.Snapshot, err
}

func (p *Provider) EnterMaintenance(ctx context.Context, target contracts.TargetRef) (Assessment, error) {
	if err := p.API.SetPaused(ctx, true); err != nil {
		return Assessment{}, err
	}
	assessment, err := p.Assess(ctx, target)
	if err != nil {
		return Assessment{}, err
	}
	if !assessment.Config.Paused {
		return assessment, errors.New("Patroni did not enter paused maintenance state")
	}
	return assessment, nil
}

func (p *Provider) ExitMaintenance(ctx context.Context) error { return p.API.SetPaused(ctx, false) }

func (p *Provider) RebuildStandbys(ctx context.Context, target contracts.TargetRef, snapshot contracts.TopologySnapshot) (contracts.Evidence, error) {
	if p.Rebuilder == nil {
		return contracts.Evidence{}, contracts.ErrUnsupported
	}
	result, err := RebuildCluster(ctx, p, target, snapshot, p.Rebuilder, 16<<20)
	if err != nil {
		return contracts.Evidence{}, err
	}
	return result.Evidence, nil
}

func (p *Provider) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}
