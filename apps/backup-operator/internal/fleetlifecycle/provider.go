package fleetlifecycle

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

type CompatibilityRule struct {
	Action       Action
	Adapter      Adapter
	MinimumMajor map[string]int
}

type Matrix struct {
	rules map[Action]map[Adapter]CompatibilityRule
}

func DefaultMatrix() Matrix {
	common := map[string]int{"postgres": 15, "fleetControl": 1, "agent": 1, "adapter": 1}
	m := Matrix{rules: map[Action]map[Adapter]CompatibilityRule{}}
	register := func(action Action, adapters ...Adapter) {
		m.rules[action] = map[Adapter]CompatibilityRule{}
		for _, adapter := range adapters {
			required := map[string]int{}
			for name, version := range common {
				required[name] = version
			}
			m.rules[action][adapter] = CompatibilityRule{Action: action, Adapter: adapter, MinimumMajor: required}
		}
	}
	register(RuntimeRestart, Compose, Kubernetes)
	register(RuntimeRollout, Compose, Kubernetes)
	register(RuntimeScale, Compose, Kubernetes)
	register(PostgresUpgradePlan, Compose, Kubernetes)
	register(PostgresUpgradeExecute, Kubernetes)
	register(ReplicaCreate, Kubernetes)
	register(ReplicaRemove, Kubernetes)
	register(NetworkBansRead, Compose, Kubernetes)
	register(NetworkBansUpdate, Compose, Kubernetes)
	register(BranchCreate, Kubernetes)
	register(BranchRestore, Kubernetes)
	return m
}

type CompatibilityBlocker struct {
	Code        string `json:"code"`
	Component   string `json:"component,omitempty"`
	Message     string `json:"message"`
	Remediation string `json:"remediation,omitempty"`
}

func (m Matrix) Evaluate(action Action, adapter Adapter, versions ComponentVersions) []CompatibilityBlocker {
	byAdapter := m.rules[action]
	rule, ok := byAdapter[adapter]
	if !ok {
		return []CompatibilityBlocker{{Code: "provider_not_registered", Message: fmt.Sprintf("%s has no %s provider", action, adapter), Remediation: "Install a compatible lifecycle provider or choose a supported management target."}}
	}
	if err := versions.Validate(); err != nil {
		return []CompatibilityBlocker{{Code: "version_observation_incomplete", Message: err.Error(), Remediation: "Refresh Stack Agent component discovery."}}
	}
	values := map[string]string{"postgres": versions.Postgres, "fleetControl": versions.FleetControl, "agent": versions.Agent, "adapter": versions.Adapter}
	blockers := []CompatibilityBlocker{}
	for component, minimum := range rule.MinimumMajor {
		major, err := versionMajor(values[component])
		if err != nil || major < minimum {
			blockers = append(blockers, CompatibilityBlocker{Code: "target_version_incompatible", Component: component, Message: fmt.Sprintf("%s requires %s major %d or newer", action, component, minimum), Remediation: "Upgrade the component and refresh Agent discovery before planning this action."})
		}
	}
	return blockers
}

func versionMajor(value string) (int, error) {
	trimmed := strings.TrimPrefix(strings.TrimSpace(value), "v")
	first := strings.SplitN(trimmed, ".", 2)[0]
	return strconv.Atoi(first)
}

type Request struct {
	OperationID        string
	ProjectRef         string
	TargetID           string
	BindingID          string
	ExpectedGeneration int64
	Document           Document
}

type Provider interface {
	Adapter() Adapter
	Capabilities() []Action
	Execute(context.Context, Request) (Evidence, error)
}

type Registry struct {
	providers map[Adapter]Provider
	matrix    Matrix
	now       func() time.Time
}

func NewRegistry(matrix Matrix, providers ...Provider) (*Registry, error) {
	r := &Registry{providers: map[Adapter]Provider{}, matrix: matrix, now: time.Now}
	for _, provider := range providers {
		if provider == nil || provider.Adapter() == "" || len(provider.Capabilities()) == 0 {
			return nil, errors.New("complete lifecycle provider is required")
		}
		if _, exists := r.providers[provider.Adapter()]; exists {
			return nil, errors.New("duplicate lifecycle provider")
		}
		r.providers[provider.Adapter()] = provider
	}
	return r, nil
}

func (r *Registry) Execute(ctx context.Context, request Request) (Evidence, error) {
	if request.OperationID == "" || request.ProjectRef == "" || request.TargetID == "" || request.BindingID == "" || request.ExpectedGeneration < 1 {
		return Evidence{}, errors.New("complete lifecycle operation identity is required")
	}
	if err := request.Document.Validate(r.now()); err != nil {
		return Evidence{}, err
	}
	if blockers := r.matrix.Evaluate(request.Document.Action, request.Document.Adapter, request.Document.ComponentVersions); len(blockers) != 0 {
		return Evidence{}, errors.New(blockers[0].Code)
	}
	provider := r.providers[request.Document.Adapter]
	if provider == nil {
		return Evidence{}, errors.New("provider_not_registered")
	}
	for _, capability := range provider.Capabilities() {
		if capability == request.Document.Action {
			return provider.Execute(ctx, request)
		}
	}
	return Evidence{}, errors.New("capability_unavailable")
}
