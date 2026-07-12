package kubernetes

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

const (
	PG17Image       = "deluxebear/postgres:17"
	OrioleDB17Image = "deluxebear/postgres:orioledb-17"
)

type Pod struct {
	Name             string
	Role             contracts.NodeRole
	Ready            bool
	SystemIdentifier string
	Timeline         uint64
	LagBytes         int64
	PVCs             []string
}

type PVC struct {
	Name          string
	UID           string
	AccessModes   []string
	CapacityBytes int64
	AttachedPod   string
}

type Service struct {
	Name     string
	Selector map[string]string
}

type Workload struct {
	Namespace         string
	StatefulSet       string
	Image             string
	OwnerKind         string
	OwnerName         string
	PgBackRestBinary  string
	PgBackRestVersion string
	PgBackRestConfig  string
	Pods              []Pod
	PVCs              []PVC
	Services          []Service
	AvailableBytes    int64
}

type Discoverer interface {
	Discover(context.Context, contracts.TargetRef) (Workload, error)
}

type Compatibility struct {
	Supported bool
	Image     string
	Provider  string
	Blocker   string
}

type Assessment struct {
	Workload      Workload
	Topology      contracts.TopologySnapshot
	Compatibility Compatibility
	Blockers      []string
}

type Provider struct {
	ProviderID string
	Discoverer Discoverer
	Now        func() time.Time
}

func (p Provider) ID() string { return p.ProviderID }

func (p Provider) Assess(ctx context.Context, target contracts.TargetRef) (Assessment, error) {
	if p.ProviderID == "" || p.Discoverer == nil {
		return Assessment{}, errors.New("Kubernetes provider is incomplete")
	}
	workload, err := p.Discoverer.Discover(ctx, target)
	if err != nil {
		return Assessment{}, err
	}
	now := p.now()
	assessment := Assessment{Workload: workload, Compatibility: checkCompatibility(workload)}
	assessment.Topology = contracts.TopologySnapshot{
		Kind: contracts.TopologyKubernetesSelfOwned, Authority: workload.StatefulSet, ControllerOwner: workload.OwnerKind,
		Evidence: contracts.Evidence{ProviderID: p.ProviderID, ObservationID: workload.Namespace + "/" + workload.StatefulSet, ObservedAt: now, ValidUntil: now.Add(30 * time.Second), Facts: map[string]string{
			"image": workload.Image, "pgbackrest_version": workload.PgBackRestVersion,
		}},
	}
	if workload.OwnerKind != "" && workload.OwnerKind != "StatefulSet" {
		assessment.Blockers = append(assessment.Blockers, fmt.Sprintf("workload is owned by %s/%s", workload.OwnerKind, workload.OwnerName))
		assessment.Topology.Kind = contracts.TopologyManagedOperator
	}
	if !assessment.Compatibility.Supported {
		assessment.Blockers = append(assessment.Blockers, assessment.Compatibility.Blocker)
	}
	for _, pod := range workload.Pods {
		assessment.Topology.Nodes = append(assessment.Topology.Nodes, contracts.NodeObservation{
			NodeID: pod.Name, Role: pod.Role, Reachable: pod.Ready, SystemIdentifier: pod.SystemIdentifier, Timeline: pod.Timeline, LagBytes: pod.LagBytes,
		})
	}
	for _, pvc := range workload.PVCs {
		if !contains(pvc.AccessModes, "ReadWriteOnce") && !contains(pvc.AccessModes, "ReadWriteOncePod") {
			assessment.Blockers = append(assessment.Blockers, "PVC "+pvc.Name+" is not RWO/RWOP")
		}
		if pvc.UID == "" || pvc.CapacityBytes <= 0 {
			assessment.Blockers = append(assessment.Blockers, "PVC "+pvc.Name+" identity or capacity is unavailable")
		}
	}
	if workload.AvailableBytes <= 0 {
		assessment.Blockers = append(assessment.Blockers, "replacement capacity is unavailable")
	}
	return assessment, nil
}

func (p Provider) Observe(ctx context.Context, target contracts.TargetRef) (contracts.TopologySnapshot, error) {
	assessment, err := p.Assess(ctx, target)
	return assessment.Topology, err
}

func (p Provider) RebuildStandbys(context.Context, contracts.TargetRef, contracts.TopologySnapshot) (contracts.Evidence, error) {
	return contracts.Evidence{}, contracts.ErrUnsupported
}

func checkCompatibility(workload Workload) Compatibility {
	result := Compatibility{Image: workload.Image, Provider: "custom-image-pgbackrest"}
	if workload.Image != PG17Image && workload.Image != OrioleDB17Image {
		result.Blocker = "database image is outside the explicit customized Postgres allowlist"
		return result
	}
	if workload.PgBackRestBinary != "/usr/lib/pgbackrest/bin/pgbackrest.real" || strings.TrimSpace(workload.PgBackRestVersion) == "" || workload.PgBackRestConfig == "" {
		result.Blocker = "database image does not expose the managed pgBackRest binary/configuration"
		return result
	}
	result.Supported = true
	return result
}

func (p Provider) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
