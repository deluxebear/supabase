package app

import "strings"

const (
	CapabilitySinglePrimary = "single-primary-pgbackrest"
	CapabilityPatroni       = "patroni-pgbackrest"
	CapabilityKubernetes    = "custom-postgres-kubernetes"
	CapabilityCloudNativePG = "cloudnativepg-cnpg-i"
)

type ProviderCapability struct {
	Name      string `json:"name"`
	Supported bool   `json:"supported"`
	Blocker   string `json:"blocker,omitempty"`
}

type ProviderRegistry struct {
	providers map[string]ProviderCapability
}

func NewProviderRegistry() *ProviderRegistry {
	registry := &ProviderRegistry{providers: make(map[string]ProviderCapability)}
	registry.Block(CapabilitySinglePrimary, "provider is not configured")
	registry.Block(CapabilityPatroni, "provider is not configured")
	registry.Block(CapabilityKubernetes, "provider is not configured")
	registry.Block(CapabilityCloudNativePG, "optional provider feature gate is disabled")
	return registry
}

func (r *ProviderRegistry) Register(name string) {
	if r == nil || strings.TrimSpace(name) == "" {
		return
	}
	r.providers[name] = ProviderCapability{Name: name, Supported: true}
}

func (r *ProviderRegistry) Block(name, blocker string) {
	if r == nil || strings.TrimSpace(name) == "" {
		return
	}
	r.providers[name] = ProviderCapability{Name: name, Supported: false, Blocker: blocker}
}

func (r *ProviderRegistry) Snapshot() []ProviderCapability {
	defaults := NewProviderRegistry()
	if r != nil {
		for name, provider := range r.providers {
			defaults.providers[name] = provider
		}
	}
	names := []string{CapabilitySinglePrimary, CapabilityPatroni, CapabilityKubernetes, CapabilityCloudNativePG}
	result := make([]ProviderCapability, 0, len(names))
	for _, name := range names {
		result = append(result, defaults.providers[name])
	}
	return result
}
