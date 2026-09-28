package fleetfunctions

import (
	"context"
	"errors"
)

type Provider interface {
	Adapter() AdapterKind
	Deploy(context.Context, Request) (Evidence, error)
}

type Registry struct{ providers map[AdapterKind]Provider }

func NewRegistry(providers ...Provider) (*Registry, error) {
	registry := &Registry{providers: make(map[AdapterKind]Provider, len(providers))}
	for _, provider := range providers {
		if provider == nil || provider.Adapter() == "" {
			return nil, errors.New("complete function deployment provider is required")
		}
		if _, duplicate := registry.providers[provider.Adapter()]; duplicate {
			return nil, errors.New("duplicate function deployment provider")
		}
		registry.providers[provider.Adapter()] = provider
	}
	return registry, nil
}

func (r *Registry) Deploy(ctx context.Context, request Request) (Evidence, error) {
	if err := request.Validate(); err != nil {
		return Evidence{}, err
	}
	provider := r.providers[request.Deployment.Adapter]
	if provider == nil {
		return Evidence{}, errors.New("function deployment provider is unavailable")
	}
	return provider.Deploy(ctx, request)
}

type Prober interface {
	Probe(context.Context, string, bool) error
}

type RevisionProber interface {
	ProbeRevision(context.Context, string, bool, string) error
}

type ProbeFunc func(context.Context, string, bool) error

func (f ProbeFunc) Probe(ctx context.Context, slug string, shouldExist bool) error {
	return f(ctx, slug, shouldExist)
}

// RolloutRuntime reports whether the Edge Runtime workload is available.
type RolloutRuntime interface {
	WaitForRollout(context.Context, string, string) error
}
