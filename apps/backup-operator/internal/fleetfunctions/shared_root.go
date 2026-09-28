package fleetfunctions

import (
	"context"
	"path/filepath"
	"time"
)

// sharedRootDeployment deploys into a function root that the Edge Runtime
// reads directly: Compose bind-mounts it, and Kubernetes mounts it from a
// shared volume. The layout is the one docker/volumes/functions/main/index.ts
// serves: <root>/<project key>/.fleet-artifacts/<slug>/revisions/<digest>
// holds immutable revisions, and <root>/<project key>/<slug> is a copy of the
// active one with a .fleet-runtime-revision marker. The main service reads the
// marker on every request, so activation needs no restart.
type sharedRootDeployment struct {
	Root    string
	Adapter AdapterKind
	Prober  Prober
	Switch  func(string, string) error
	Now     func() time.Time
	// Ready, when set, runs after activation and before the probe, for
	// example to wait until the Edge Runtime Deployment is available.
	Ready func(context.Context) error
}

func deployOnSharedRoot(ctx context.Context, request Request, p sharedRootDeployment) (Evidence, error) {
	projectRoot := filepath.Join(p.Root, projectKey(request.ProjectRef))
	root := filepath.Join(projectRoot, ".fleet-artifacts", request.Deployment.Slug)
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
	var rolloutErr error
	if request.Deployment.Action == ActionDeploy {
		rolloutErr = activateComposeRuntime(projectRoot, root, request.Deployment.Slug, desired)
	} else {
		rolloutErr = removeComposeRuntime(projectRoot, root, request.Deployment.Slug)
	}
	now := time.Now
	if p.Now != nil {
		now = p.Now
	}
	evidence := Evidence{Schema: EvidenceSchemaV1, Status: "active", Adapter: p.Adapter, Slug: request.Deployment.Slug, ArtifactDigest: desired, PreviousDigest: previous, ObservedGeneration: request.ExpectedGeneration, ActivatedAt: now().UTC()}
	if request.Deployment.Action == ActionDelete {
		evidence.Status = "deleted"
	}
	shouldExist := request.Deployment.Action == ActionDeploy
	if rolloutErr == nil && p.Ready != nil {
		rolloutErr = p.Ready(ctx)
	}
	if rolloutErr == nil {
		if prober, ok := p.Prober.(RevisionProber); ok {
			rolloutErr = prober.ProbeRevision(ctx, request.Deployment.Slug, shouldExist, desired)
		} else {
			rolloutErr = p.Prober.Probe(ctx, request.Deployment.Slug, shouldExist)
		}
	}
	if rolloutErr == nil {
		evidence.Probe = ProbeEvidence{Succeeded: true}
		return evidence, nil
	} else {
		evidence.Probe = ProbeEvidence{Succeeded: false, Message: rolloutErr.Error()}
	}
	if rollbackErr := switcher(root, previous); rollbackErr == nil {
		if previous == "" {
			rollbackErr = removeComposeRuntime(projectRoot, root, request.Deployment.Slug)
		} else {
			rollbackErr = activateComposeRuntime(projectRoot, root, request.Deployment.Slug, previous)
		}
		if rollbackErr != nil {
			evidence.Status = "manual-intervention"
			evidence.Remediation = "Restore the function current pointer to the previous immutable revision and verify Edge Runtime before releasing the operation."
			return evidence, &DeploymentError{Code: "manual_intervention_required", Evidence: evidence}
		}
		evidence.Status = "rolled-back"
		evidence.ArtifactDigest = previous
		evidence.Remediation = "Inspect the immutable artifact and Edge Runtime logs, then deploy a corrected revision."
		return evidence, &DeploymentError{Code: "rollout_probe_failed", Evidence: evidence}
	}
	evidence.Status = "manual-intervention"
	evidence.Remediation = "Restore the function current pointer to the previous immutable revision and verify Edge Runtime before releasing the operation."
	return evidence, &DeploymentError{Code: "manual_intervention_required", Evidence: evidence}
}
