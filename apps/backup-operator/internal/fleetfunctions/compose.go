package fleetfunctions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

type ComposeProvider struct {
	Root   string
	Prober Prober
	Switch func(string, string) error
	Now    func() time.Time
}

func (ComposeProvider) Adapter() AdapterKind { return AdapterCompose }

func (p ComposeProvider) Deploy(ctx context.Context, request Request) (Evidence, error) {
	if err := request.Validate(); err != nil {
		return Evidence{}, err
	}
	if p.Root == "" || p.Prober == nil {
		return Evidence{}, errors.New("Compose function provider is not configured")
	}
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
	runtimeCreated, err := prepareComposeRuntimePointer(projectRoot, request.Deployment.Slug, request.Deployment.Action == ActionDeploy)
	if err != nil {
		return Evidence{}, err
	}
	if err := switcher(root, desired); err != nil {
		if runtimeCreated {
			_ = removeComposeRuntimePointer(projectRoot, request.Deployment.Slug)
		}
		return Evidence{}, err
	}
	var rolloutErr error
	if request.Deployment.Action == ActionDelete {
		rolloutErr = removeComposeRuntimePointer(projectRoot, request.Deployment.Slug)
	}
	now := time.Now
	if p.Now != nil {
		now = p.Now
	}
	evidence := Evidence{Schema: EvidenceSchemaV1, Status: "active", Adapter: AdapterCompose, Slug: request.Deployment.Slug, ArtifactDigest: desired, PreviousDigest: previous, ObservedGeneration: request.ExpectedGeneration, ActivatedAt: now().UTC()}
	if request.Deployment.Action == ActionDelete {
		evidence.Status = "deleted"
	}
	shouldExist := request.Deployment.Action == ActionDeploy
	if rolloutErr == nil {
		rolloutErr = p.Prober.Probe(ctx, request.Deployment.Slug, shouldExist)
	}
	if rolloutErr == nil {
		evidence.Probe = ProbeEvidence{Succeeded: true}
		return evidence, nil
	} else {
		evidence.Probe = ProbeEvidence{Succeeded: false, Message: "Edge Runtime rollout probe failed"}
	}
	if rollbackErr := switcher(root, previous); rollbackErr == nil {
		if previous == "" {
			rollbackErr = removeComposeRuntimePointer(projectRoot, request.Deployment.Slug)
		} else {
			_, rollbackErr = prepareComposeRuntimePointer(projectRoot, request.Deployment.Slug, true)
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

func prepareComposeRuntimePointer(projectRoot, slug string, create bool) (bool, error) {
	if err := os.MkdirAll(projectRoot, 0o750); err != nil {
		return false, err
	}
	pointer := filepath.Join(projectRoot, slug)
	target := filepath.Join(".fleet-artifacts", slug, "current")
	if info, err := os.Lstat(pointer); err == nil {
		if info.Mode()&os.ModeSymlink == 0 {
			return false, errors.New("ownership_conflict: Edge Runtime function path is not a Fleet-owned symlink")
		}
		stored, err := os.Readlink(pointer)
		if err != nil || stored != target {
			return false, errors.New("ownership_conflict: Edge Runtime function path points outside its Fleet artifact")
		}
		return false, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return false, err
	}
	if !create {
		return false, nil
	}
	temporary := filepath.Join(projectRoot, ".runtime-next-"+slug)
	_ = os.Remove(temporary)
	if err := os.Symlink(target, temporary); err != nil {
		return false, err
	}
	if err := os.Rename(temporary, pointer); err != nil {
		_ = os.Remove(temporary)
		return false, err
	}
	return true, nil
}

func removeComposeRuntimePointer(projectRoot, slug string) error {
	if _, err := prepareComposeRuntimePointer(projectRoot, slug, false); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(projectRoot, slug)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func projectKey(projectRef string) string {
	digest := sha256.Sum256([]byte(projectRef))
	return hex.EncodeToString(digest[:12])
}
