package fleetdatabase

import (
	"context"
	"errors"
	"strings"
)

type RuntimeSnapshot struct {
	SSL     SSLPolicy
	Network NetworkPolicy
	Pooler  PoolerPolicy
}

type Runtime interface {
	Snapshot(context.Context) (RuntimeSnapshot, error)
	Apply(context.Context, Document) error
	Probe(context.Context, Document) error
	Restore(context.Context, RuntimeSnapshot, *PasswordChange) error
}

type Provider interface {
	Adapter() Adapter
	Reconcile(context.Context, Request) (Evidence, error)
}

type ManagedProvider struct {
	Kind    Adapter
	Runtime Runtime
}

func (p ManagedProvider) Adapter() Adapter { return p.Kind }

func (p ManagedProvider) Reconcile(ctx context.Context, request Request) (Evidence, error) {
	if err := request.Validate(); err != nil {
		return Evidence{}, err
	}
	if p.Runtime == nil || p.Kind != request.Document.Adapter {
		return Evidence{}, errors.New("database security provider is unavailable")
	}
	previous, err := p.Runtime.Snapshot(ctx)
	if err != nil {
		evidence := Evidence{Schema: EvidenceSchemaV1, Adapter: p.Kind, Status: "failed", ObservedGeneration: request.ExpectedGeneration, ObservedDigest: request.DesiredDigest, Health: "unhealthy", ErrorCode: observationErrorCode(err), Remediation: "Verify the operator database identity, Supavisor catalog, and Fleet-owned state volume."}
		return evidence, &ReconcileError{Evidence: evidence, Cause: err}
	}
	evidence := Evidence{Schema: EvidenceSchemaV1, Adapter: p.Kind, Status: "failed", ObservedGeneration: request.ExpectedGeneration, ObservedDigest: request.DesiredDigest, SSL: request.Document.SSL, Network: request.Document.Network, Pooler: request.Document.Pooler, Health: "unhealthy"}
	applyErr := p.Runtime.Apply(ctx, request.Document)
	reconcileErr := applyErr
	if applyErr == nil {
		reconcileErr = p.Runtime.Probe(ctx, request.Document)
		if reconcileErr == nil {
			evidence.Status, evidence.Applied, evidence.Health = "succeeded", true, "healthy"
			evidence.PasswordRotated = request.Document.Rotation != nil
			return evidence, nil
		}
	}
	evidence.ErrorCode = reconciliationErrorCode(reconcileErr, applyErr != nil)
	if restoreErr := p.Runtime.Restore(ctx, previous, request.Document.Rotation); restoreErr != nil {
		evidence.Status = "manual-intervention"
		evidence.RollbackErrorCode = reconciliationErrorCode(restoreErr, true)
		evidence.Remediation = "Restore the previous database security configuration and credentials, then verify direct and pooled connections."
		return evidence, &ReconcileError{Evidence: evidence, Cause: errors.Join(reconcileErr, restoreErr)}
	}
	evidence.Status, evidence.RolledBack = "rolled-back", true
	evidence.SSL, evidence.Network, evidence.Pooler = previous.SSL, previous.Network, previous.Pooler
	return evidence, &ReconcileError{Evidence: evidence, Cause: reconcileErr}
}

func reconciliationErrorCode(err error, applying bool) string {
	if err == nil {
		return "verification_failed"
	}
	message := err.Error()
	switch {
	case strings.Contains(message, "Supavisor database security settings"):
		return "pooler_update_failed"
	case strings.Contains(message, "database security state"):
		return "state_write_failed"
	case strings.Contains(message, "credential"):
		return "credential_rotation_failed"
	case applying:
		return "apply_failed"
	default:
		return "verification_failed"
	}
}

func observationErrorCode(err error) string {
	switch message := err.Error(); {
	case strings.Contains(message, "connect to Supavisor catalog"):
		return "catalog_connect_failed"
	case strings.Contains(message, "read Supavisor"):
		return "catalog_read_failed"
	case strings.Contains(message, "state"):
		return "state_read_failed"
	default:
		return "observation_failed"
	}
}

type ReconcileError struct {
	Evidence Evidence
	Cause    error
}

func (e *ReconcileError) Error() string { return "database security reconciliation failed" }
func (e *ReconcileError) Unwrap() error { return e.Cause }

type Registry struct{ providers map[Adapter]Provider }

func NewRegistry(providers ...Provider) (*Registry, error) {
	registry := &Registry{providers: make(map[Adapter]Provider, len(providers))}
	for _, provider := range providers {
		if provider == nil || provider.Adapter() == "" {
			return nil, errors.New("complete database security provider is required")
		}
		if _, exists := registry.providers[provider.Adapter()]; exists {
			return nil, errors.New("duplicate database security provider")
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
		return Evidence{}, errors.New("database security provider is unavailable")
	}
	return provider.Reconcile(ctx, request)
}
