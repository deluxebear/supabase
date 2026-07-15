package fleetproviders

import (
	"context"
	"errors"
)

type Provider interface {
	Adapter() AdapterKind
	Reconcile(context.Context, Request) (Evidence, error)
}

type Registry struct {
	providers map[AdapterKind]Provider
}

func NewRegistry(providers ...Provider) (*Registry, error) {
	registry := &Registry{providers: make(map[AdapterKind]Provider, len(providers))}
	for _, provider := range providers {
		if provider == nil || provider.Adapter() == "" {
			return nil, errors.New("complete reconciliation provider is required")
		}
		if _, exists := registry.providers[provider.Adapter()]; exists {
			return nil, errors.New("duplicate reconciliation provider")
		}
		registry.providers[provider.Adapter()] = provider
	}
	return registry, nil
}

func (r *Registry) Reconcile(ctx context.Context, request Request) (Evidence, error) {
	if err := request.Validate(); err != nil {
		return Evidence{}, err
	}
	provider := r.providers[request.Document.Adapter]
	if provider == nil {
		return Evidence{}, errors.New("reconciliation provider is unavailable")
	}
	return provider.Reconcile(ctx, request)
}
