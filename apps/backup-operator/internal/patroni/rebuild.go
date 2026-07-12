package patroni

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

type StandbyRebuilder interface {
	StopCluster(context.Context, []string) error
	StartRecoveredPrimary(context.Context, string) error
	Reinitialize(context.Context, string) error
	FreshRebuild(context.Context, string) error
	ArchiveHealthy(context.Context, string) error
}

type NodeRebuild struct {
	NodeID string
	State  string
	Error  string
}

type RebuildResult struct {
	Primary  string
	Nodes    []NodeRebuild
	Manual   bool
	Evidence contracts.Evidence
}

func RebuildCluster(ctx context.Context, provider *Provider, target contracts.TargetRef, before contracts.TopologySnapshot, rebuilder StandbyRebuilder, maxLagBytes int64) (RebuildResult, error) {
	if provider == nil || rebuilder == nil || maxLagBytes < 0 {
		return RebuildResult{}, errors.New("provider, rebuilder, and lag threshold are required")
	}
	if err := before.ValidateForDestructive(provider.now()); err != nil {
		return RebuildResult{}, err
	}
	primary := ""
	var primaryTimeline uint64
	members := make([]string, 0, len(before.Nodes))
	for _, node := range before.Nodes {
		members = append(members, node.NodeID)
		if node.Role == contracts.RolePrimary {
			primary = node.NodeID
			primaryTimeline = node.Timeline
		}
	}
	if err := rebuilder.StopCluster(ctx, members); err != nil {
		return RebuildResult{}, fmt.Errorf("stop Patroni cluster: %w", err)
	}
	if err := provider.DCS.Reconcile(ctx, primary, primaryTimeline+1); err != nil {
		return RebuildResult{}, fmt.Errorf("reconcile DCS timeline: %w", err)
	}
	if err := rebuilder.StartRecoveredPrimary(ctx, primary); err != nil {
		return RebuildResult{}, fmt.Errorf("start recovered primary: %w", err)
	}
	result := RebuildResult{Primary: primary}
	for _, node := range before.Nodes {
		if node.NodeID == primary {
			continue
		}
		rebuild := NodeRebuild{NodeID: node.NodeID, State: "reinitializing"}
		err := rebuilder.Reinitialize(ctx, node.NodeID)
		if err != nil {
			err = rebuilder.FreshRebuild(ctx, node.NodeID)
		}
		if err != nil {
			rebuild.State = "manual"
			rebuild.Error = err.Error()
			result.Manual = true
		} else {
			rebuild.State = "rebuilt"
		}
		result.Nodes = append(result.Nodes, rebuild)
	}
	if result.Manual {
		return result, errors.New("one or more standbys require manual rebuild")
	}
	after, err := provider.Observe(ctx, target)
	if err != nil {
		return result, err
	}
	if err := after.ValidateForDestructive(provider.now()); err != nil {
		return result, err
	}
	for _, node := range after.Nodes {
		if node.Role == contracts.RoleStandby && node.LagBytes > maxLagBytes {
			return result, fmt.Errorf("standby %s lag %d exceeds %d", node.NodeID, node.LagBytes, maxLagBytes)
		}
	}
	if err := rebuilder.ArchiveHealthy(ctx, primary); err != nil {
		return result, err
	}
	now := provider.now()
	result.Evidence = contracts.Evidence{ProviderID: provider.ID(), ObservationID: after.Evidence.ObservationID + "-rebuilt", ObservedAt: now, ValidUntil: now.Add(30 * time.Second), Facts: map[string]string{"primary": primary, "standbys": strconv.Itoa(len(result.Nodes))}}
	return result, nil
}
