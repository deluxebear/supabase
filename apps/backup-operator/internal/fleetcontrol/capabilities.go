package fleetcontrol

import (
	"errors"
	"sort"
	"sync"

	"github.com/supabase/supabase/apps/backup-operator/internal/fleetdatabase"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetfunctions"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetinventory"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetlifecycle"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetproviders"
)

type Blocker struct {
	Code        string `json:"code"`
	Message     string `json:"message"`
	Remediation string `json:"remediation,omitempty"`
}

type Capability struct {
	Name            string    `json:"name"`
	State           string    `json:"state"`
	Mode            string    `json:"mode"`
	Source          string    `json:"source"`
	ContractVersion string    `json:"contractVersion"`
	InputSchema     string    `json:"-"`
	EvidenceSchema  string    `json:"-"`
	Blockers        []Blocker `json:"blockers"`
}

type CapabilityRegistry struct {
	mu           sync.RWMutex
	capabilities map[string]Capability
}

func NewCapabilityRegistry() *CapabilityRegistry {
	registry := &CapabilityRegistry{capabilities: make(map[string]Capability)}
	registry.capabilities[fleetinventory.CapabilityObserve] = Capability{
		Name: fleetinventory.CapabilityObserve, State: "available", Mode: "agent", Source: "fleet-control", ContractVersion: "v1",
		InputSchema: fleetinventory.InputSchemaV1, EvidenceSchema: fleetinventory.EvidenceSchemaV1, Blockers: []Blocker{},
	}
	registry.capabilities[fleetproviders.CapabilityReconcileConfiguration] = Capability{
		Name: fleetproviders.CapabilityReconcileConfiguration, State: "available", Mode: "agent", Source: "fleet-control", ContractVersion: "v1",
		InputSchema: fleetproviders.InputSchemaV1, EvidenceSchema: fleetproviders.EvidenceSchemaV1, Blockers: []Blocker{},
	}
	registry.capabilities[fleetfunctions.CapabilityDeploy] = Capability{
		Name: fleetfunctions.CapabilityDeploy, State: "available", Mode: "agent", Source: "fleet-control", ContractVersion: "v1",
		InputSchema: fleetfunctions.InputSchemaV1, EvidenceSchema: fleetfunctions.EvidenceSchemaV1, Blockers: []Blocker{},
	}
	registry.capabilities[fleetdatabase.CapabilityReconcile] = Capability{
		Name: fleetdatabase.CapabilityReconcile, State: "available", Mode: "agent", Source: "fleet-control", ContractVersion: "v1",
		InputSchema: fleetdatabase.InputSchemaV1, EvidenceSchema: fleetdatabase.EvidenceSchemaV1, Blockers: []Blocker{},
	}
	for action := range map[fleetlifecycle.Action]struct{}{
		fleetlifecycle.RuntimeRestart: {}, fleetlifecycle.RuntimeRollout: {}, fleetlifecycle.RuntimeScale: {},
		fleetlifecycle.PostgresUpgradePlan: {}, fleetlifecycle.PostgresUpgradeExecute: {},
		fleetlifecycle.ReplicaCreate: {}, fleetlifecycle.ReplicaRemove: {},
		fleetlifecycle.BranchCreate: {}, fleetlifecycle.BranchRestore: {},
		fleetlifecycle.NetworkBansRead: {}, fleetlifecycle.NetworkBansUpdate: {},
	} {
		registry.capabilities[string(action)] = Capability{Name: string(action), State: "available", Mode: "agent", Source: "fleet-control", ContractVersion: "v1", InputSchema: fleetlifecycle.InputSchemaV1, EvidenceSchema: fleetlifecycle.EvidenceSchemaV1, Blockers: []Blocker{}}
	}
	return registry
}

// RegisterAvailable is used only by a concrete provider during process
// assembly. T8 registers the ownership-safe reconciliation transport while
// target availability still fails closed against the bound Agent capability.
func (r *CapabilityRegistry) RegisterAvailable(capability Capability) error {
	if r == nil || capability.Name == "" || capability.InputSchema == "" || capability.EvidenceSchema == "" || capability.ContractVersion == "" || capability.Mode == "" || capability.Mode == "unsupported" {
		return errors.New("complete executable provider capability is required")
	}
	capability.State = "available"
	capability.Source = "fleet-control"
	capability.Blockers = []Blocker{}
	r.mu.Lock()
	r.capabilities[capability.Name] = capability
	r.mu.Unlock()
	return nil
}

func (r *CapabilityRegistry) Get(name string) (Capability, bool) {
	if r == nil {
		return Capability{}, false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	capability, ok := r.capabilities[name]
	capability.Blockers = append([]Blocker(nil), capability.Blockers...)
	return capability, ok
}

func (r *CapabilityRegistry) List() []Capability {
	if r == nil {
		return []Capability{}
	}
	r.mu.RLock()
	result := make([]Capability, 0, len(r.capabilities))
	for _, capability := range r.capabilities {
		capability.Blockers = append([]Blocker(nil), capability.Blockers...)
		if capability.Blockers == nil {
			capability.Blockers = []Blocker{}
		}
		result = append(result, capability)
	}
	r.mu.RUnlock()
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}

func (r *CapabilityRegistry) Schemas() map[string]string {
	result := make(map[string]string)
	for _, capability := range r.List() {
		result[capability.Name] = capability.InputSchema
	}
	return result
}

func (r *CapabilityRegistry) Observations(names []string) ([]CapabilityObservation, error) {
	if r == nil || len(names) == 0 || len(names) > 256 {
		return nil, errors.New("between 1 and 256 executable Agent capabilities are required")
	}
	seen := make(map[string]struct{}, len(names))
	result := make([]CapabilityObservation, 0, len(names))
	for _, name := range names {
		if _, duplicate := seen[name]; duplicate {
			return nil, errors.New("duplicate executable Agent capability")
		}
		capability, ok := r.Get(name)
		if !ok || capability.State != "available" || capability.InputSchema == "" || capability.EvidenceSchema == "" {
			return nil, errors.New("Agent advertised an unavailable executable capability")
		}
		seen[name] = struct{}{}
		result = append(result, CapabilityObservation{Domain: "fleet", Name: name, ContractVersion: capability.ContractVersion, InputSchema: capability.InputSchema, EvidenceSchema: capability.EvidenceSchema})
	}
	return result, nil
}
