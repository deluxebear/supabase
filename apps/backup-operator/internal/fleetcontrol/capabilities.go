package fleetcontrol

import (
	"errors"
	"sort"
	"sync"

	"github.com/supabase/supabase/apps/backup-operator/internal/fleetfunctions"
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
	Blockers        []Blocker `json:"blockers"`
}

type CapabilityRegistry struct {
	mu           sync.RWMutex
	capabilities map[string]Capability
}

func NewCapabilityRegistry() *CapabilityRegistry {
	registry := &CapabilityRegistry{capabilities: make(map[string]Capability)}
	registry.capabilities["runtime.observe"] = Capability{
		Name: "runtime.observe", State: "unsupported", Mode: "unsupported", Source: "fleet-control", ContractVersion: "v1",
		InputSchema: "supabase.fleet.runtime.observe.v1",
		Blockers:    []Blocker{{Code: "provider_not_registered", Message: "No compatible Fleet runtime observation provider is registered", Remediation: "Enroll a compatible Stack Agent after management-target trust is configured"}},
	}
	registry.capabilities[fleetproviders.CapabilityReconcileConfiguration] = Capability{
		Name: fleetproviders.CapabilityReconcileConfiguration, State: "available", Mode: "agent", Source: "fleet-control", ContractVersion: "v1",
		InputSchema: fleetproviders.InputSchemaV1, Blockers: []Blocker{},
	}
	registry.capabilities[fleetfunctions.CapabilityDeploy] = Capability{
		Name: fleetfunctions.CapabilityDeploy, State: "available", Mode: "agent", Source: "fleet-control", ContractVersion: "v1",
		InputSchema: fleetfunctions.InputSchemaV1, Blockers: []Blocker{},
	}
	return registry
}

// RegisterAvailable is used only by a concrete provider during process
// assembly. T8 registers the ownership-safe reconciliation transport while
// target availability still fails closed against the bound Agent capability.
func (r *CapabilityRegistry) RegisterAvailable(capability Capability) error {
	if r == nil || capability.Name == "" || capability.InputSchema == "" || capability.ContractVersion == "" || capability.Mode == "" || capability.Mode == "unsupported" {
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
