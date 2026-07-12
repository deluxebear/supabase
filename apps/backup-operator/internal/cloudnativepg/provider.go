package cloudnativepg

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

const (
	ClusterAPIVersion = "postgresql.cnpg.io/v1"
	ClusterKind       = "Cluster"
	BarmanPluginName  = "barman-cloud.cloudnative-pg.io"
	MinimumCNPG       = "1.26.0"
	TestedCNPG        = "1.29.1"
	TestedBarman      = "0.13.0"
)

var dnsName = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$`)

type Prerequisites struct {
	CNPGVersion         string
	BarmanPluginVersion string
	CertManagerReady    bool
	PluginReady         bool
}

type ClusterObservation struct {
	APIVersion       string
	Kind             string
	Namespace        string
	Name             string
	UID              string
	ControllerOwner  string
	Image            string
	Instances        int
	ReadyInstances   int
	CurrentPrimary   string
	SystemIdentifier string
	Timeline         uint64
	Phase            string
	PVCUIDs          []string
	ObjectStore      string
	ServerName       string
	Prerequisites    Prerequisites
}

type Discoverer interface {
	Discover(context.Context, contracts.TargetRef) (ClusterObservation, error)
}

type Capability struct {
	Enabled  bool
	Blockers []string
	Cluster  ClusterObservation
	Evidence contracts.Evidence
}

type Provider struct {
	Discoverer Discoverer
	Now        func() time.Time
}

func (p Provider) ID() string { return "cloudnativepg-cnpg-i" }

func (p Provider) Capabilities(ctx context.Context, target contracts.TargetRef) (Capability, error) {
	if p.Discoverer == nil {
		return Capability{}, errors.New("CloudNativePG discoverer is required")
	}
	cluster, err := p.Discoverer.Discover(ctx, target)
	if err != nil {
		return Capability{}, err
	}
	now := p.now()
	capability := Capability{
		Cluster: cluster,
		Evidence: contracts.Evidence{
			ProviderID: p.ID(), ObservationID: cluster.UID, ObservedAt: now, ValidUntil: now.Add(30 * time.Second),
			Facts: map[string]string{"cluster": cluster.Namespace + "/" + cluster.Name, "cnpg_version": cluster.Prerequisites.CNPGVersion, "plugin_version": cluster.Prerequisites.BarmanPluginVersion},
		},
	}
	if cluster.APIVersion != ClusterAPIVersion || cluster.Kind != ClusterKind || cluster.ControllerOwner != "cloudnative-pg" || cluster.UID == "" {
		capability.Blockers = append(capability.Blockers, "workload ownership is not positively identified as CloudNativePG")
	}
	if !atLeast(cluster.Prerequisites.CNPGVersion, MinimumCNPG) {
		capability.Blockers = append(capability.Blockers, "CloudNativePG 1.26.0 or newer is required for supported CNPG-I recovery")
	}
	if !cluster.Prerequisites.CertManagerReady || !cluster.Prerequisites.PluginReady || cluster.Prerequisites.BarmanPluginVersion == "" {
		capability.Blockers = append(capability.Blockers, "cert-manager and the Barman Cloud CNPG-I plugin must be installed independently and ready")
	}
	if cluster.ObjectStore == "" || cluster.ServerName == "" {
		capability.Blockers = append(capability.Blockers, "a Barman Cloud ObjectStore and source serverName are required")
	}
	if cluster.Instances < 1 || cluster.ReadyInstances != cluster.Instances || cluster.CurrentPrimary == "" || cluster.SystemIdentifier == "" || cluster.Phase != "Cluster in healthy state" {
		capability.Blockers = append(capability.Blockers, "CloudNativePG cluster topology or identity is not healthy and complete")
	}
	capability.Enabled = len(capability.Blockers) == 0
	return capability, nil
}

func (p Provider) Observe(ctx context.Context, target contracts.TargetRef) (contracts.TopologySnapshot, error) {
	capability, err := p.Capabilities(ctx, target)
	if err != nil {
		return contracts.TopologySnapshot{}, err
	}
	snapshot := contracts.TopologySnapshot{
		Kind: contracts.TopologyManagedOperator, Authority: capability.Cluster.Namespace + "/" + capability.Cluster.Name,
		ControllerOwner: "cloudnative-pg", Evidence: capability.Evidence,
	}
	for index := 0; index < capability.Cluster.Instances; index++ {
		name := fmt.Sprintf("%s-%d", capability.Cluster.Name, index+1)
		role := contracts.RoleStandby
		if name == capability.Cluster.CurrentPrimary {
			role = contracts.RolePrimary
		}
		snapshot.Nodes = append(snapshot.Nodes, contracts.NodeObservation{
			NodeID: name, Role: role, Reachable: index < capability.Cluster.ReadyInstances,
			SystemIdentifier: capability.Cluster.SystemIdentifier, Timeline: capability.Cluster.Timeline,
		})
	}
	if !capability.Enabled {
		return snapshot, fmt.Errorf("CloudNativePG capability blocked: %s", strings.Join(capability.Blockers, "; "))
	}
	return snapshot, nil
}

func (p Provider) RebuildStandbys(context.Context, contracts.TargetRef, contracts.TopologySnapshot) (contracts.Evidence, error) {
	return contracts.Evidence{}, contracts.ErrUnsupported
}

func (p Provider) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}

func atLeast(actual, minimum string) bool {
	parse := func(value string) ([3]int, bool) {
		var result [3]int
		parts := strings.Split(strings.TrimPrefix(value, "v"), ".")
		if len(parts) < 2 {
			return result, false
		}
		for index := 0; index < len(result) && index < len(parts); index++ {
			part := strings.SplitN(parts[index], "-", 2)[0]
			number, err := strconv.Atoi(part)
			if err != nil {
				return result, false
			}
			result[index] = number
		}
		return result, true
	}
	a, okA := parse(actual)
	b, okB := parse(minimum)
	if !okA || !okB {
		return false
	}
	for index := range a {
		if a[index] != b[index] {
			return a[index] > b[index]
		}
	}
	return true
}
