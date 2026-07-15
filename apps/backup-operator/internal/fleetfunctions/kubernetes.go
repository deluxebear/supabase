package fleetfunctions

import (
	"context"
	"errors"
	"path/filepath"
	"time"
)

type KubernetesProvider struct {
	ArtifactRoot string
	Runtime      RolloutRuntime
	Prober       Prober
	Switch       func(string, string) error
	Now          func() time.Time
}

func (KubernetesProvider) Adapter() AdapterKind { return AdapterKubernetes }

func (p KubernetesProvider) Deploy(ctx context.Context, request Request) (Evidence, error) {
	if err := request.Validate(); err != nil {
		return Evidence{}, err
	}
	if p.ArtifactRoot == "" || p.Runtime == nil || p.Prober == nil {
		return Evidence{}, errors.New("Kubernetes function provider is not configured")
	}
	root := filepath.Join(p.ArtifactRoot, projectKey(request.ProjectRef), request.Deployment.Slug)
	if request.Deployment.Action == ActionDeploy {
		if _, err := prepareRevision(root, request); err != nil {
			return Evidence{}, err
		}
	} else if err := verifyOrCreateOwner(root, ownerMarker{ProjectRef: request.ProjectRef, TargetID: request.TargetID, BindingID: request.BindingID, Slug: request.Deployment.Slug}); err != nil {
		return Evidence{}, err
	}
	previous, err := currentDigest(root)
	if err != nil {
		return Evidence{}, err
	}
	switcher := p.Switch
	if switcher == nil {
		switcher = switchPointer
	}
	desired := request.Deployment.ArtifactDigest
	if request.Deployment.Action == ActionDelete {
		desired = ""
	}
	if err := switcher(root, desired); err != nil {
		return Evidence{}, err
	}
	if err := p.Runtime.Activate(ctx, request.Deployment.Slug, desired); err == nil {
		err = p.Runtime.WaitForRollout(ctx, request.Deployment.Slug, desired)
	}
	if err == nil {
		err = p.Prober.Probe(ctx, request.Deployment.Slug, request.Deployment.Action == ActionDeploy)
	}
	now := time.Now
	if p.Now != nil {
		now = p.Now
	}
	evidence := Evidence{Schema: EvidenceSchemaV1, Status: "active", Adapter: AdapterKubernetes, Slug: request.Deployment.Slug, ArtifactDigest: desired, PreviousDigest: previous, ObservedGeneration: request.ExpectedGeneration, ActivatedAt: now().UTC(), Probe: ProbeEvidence{Succeeded: err == nil}}
	if request.Deployment.Action == ActionDelete && err == nil {
		evidence.Status = "deleted"
	}
	if err == nil {
		return evidence, nil
	}
	evidence.Probe.Message = "Kubernetes rollout or invocation probe failed"
	if switcher(root, previous) == nil && p.Runtime.Activate(ctx, request.Deployment.Slug, previous) == nil && p.Runtime.WaitForRollout(ctx, request.Deployment.Slug, previous) == nil {
		evidence.Status = "rolled-back"
		evidence.ArtifactDigest = previous
		evidence.Remediation = "Inspect the immutable artifact and Edge Runtime workload events, then deploy a corrected revision."
		return evidence, &DeploymentError{Code: "rollout_probe_failed", Evidence: evidence}
	}
	evidence.Status = "manual-intervention"
	evidence.Remediation = "Restore the prior artifact pointer and Kubernetes rollout revision, then verify the Edge Runtime workload manually."
	return evidence, &DeploymentError{Code: "manual_intervention_required", Evidence: evidence}
}
