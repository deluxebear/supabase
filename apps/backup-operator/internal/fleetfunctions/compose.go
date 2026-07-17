package fleetfunctions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
	evidence := Evidence{Schema: EvidenceSchemaV1, Status: "active", Adapter: AdapterCompose, Slug: request.Deployment.Slug, ArtifactDigest: desired, PreviousDigest: previous, ObservedGeneration: request.ExpectedGeneration, ActivatedAt: now().UTC()}
	if request.Deployment.Action == ActionDelete {
		evidence.Status = "deleted"
	}
	shouldExist := request.Deployment.Action == ActionDeploy
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

const (
	composeRuntimeOwnerFile    = ".fleet-runtime-owner.json"
	composeRuntimeRevisionFile = ".fleet-runtime-revision"
)

func activateComposeRuntime(projectRoot, artifactRoot, slug, digest string) error {
	if err := os.MkdirAll(projectRoot, 0o750); err != nil {
		return err
	}
	marker, err := readOwnerMarker(artifactRoot)
	if err != nil {
		return err
	}
	runtime := filepath.Join(projectRoot, slug)
	if err := verifyComposeRuntimeOwner(runtime, slug, marker, true); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(projectRoot, ".runtime-next-"+slug+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err := copyComposeRevision(filepath.Join(artifactRoot, "revisions", digest), stage); err != nil {
		return err
	}
	payload, _ := json.Marshal(marker)
	if err := os.WriteFile(filepath.Join(stage, composeRuntimeOwnerFile), payload, 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(stage, composeRuntimeRevisionFile), []byte(digest), 0o600); err != nil {
		return err
	}
	previous, err := os.MkdirTemp(projectRoot, ".runtime-previous-"+slug+"-")
	if err != nil {
		return err
	}
	if err := os.Remove(previous); err != nil {
		return err
	}
	hadRuntime := false
	if _, err := os.Lstat(runtime); err == nil {
		if err := os.Rename(runtime, previous); err != nil {
			return err
		}
		hadRuntime = true
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := os.Rename(stage, runtime); err != nil {
		if hadRuntime {
			_ = os.Rename(previous, runtime)
		}
		return err
	}
	if hadRuntime {
		return os.RemoveAll(previous)
	}
	return nil
}

func removeComposeRuntime(projectRoot, artifactRoot, slug string) error {
	marker, err := readOwnerMarker(artifactRoot)
	if err != nil {
		return err
	}
	runtime := filepath.Join(projectRoot, slug)
	if err := verifyComposeRuntimeOwner(runtime, slug, marker, true); err != nil {
		return err
	}
	if _, err := os.Lstat(runtime); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	removed, err := os.MkdirTemp(projectRoot, ".runtime-removed-"+slug+"-")
	if err != nil {
		return err
	}
	if err := os.Remove(removed); err != nil {
		return err
	}
	if err := os.Rename(runtime, removed); err != nil {
		return err
	}
	return os.RemoveAll(removed)
}

func readOwnerMarker(artifactRoot string) (ownerMarker, error) {
	payload, err := os.ReadFile(filepath.Join(artifactRoot, ".fleet-function-owner.json"))
	if err != nil {
		return ownerMarker{}, err
	}
	var marker ownerMarker
	if json.Unmarshal(payload, &marker) != nil || marker.ProjectRef == "" || marker.TargetID == "" || marker.BindingID == "" || marker.Slug == "" {
		return ownerMarker{}, errors.New("ownership_conflict: Fleet function owner marker is invalid")
	}
	return marker, nil
}

func verifyComposeRuntimeOwner(runtime, slug string, marker ownerMarker, allowMissing bool) error {
	info, err := os.Lstat(runtime)
	if errors.Is(err, fs.ErrNotExist) && allowMissing {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, readErr := os.Readlink(runtime)
		if readErr == nil && target == filepath.Join(".fleet-artifacts", slug, "current") {
			return nil
		}
		return errors.New("ownership_conflict: Edge Runtime function symlink points outside its Fleet artifact")
	}
	if !info.IsDir() {
		return errors.New("ownership_conflict: Edge Runtime function path is not a Fleet-owned directory")
	}
	payload, err := os.ReadFile(filepath.Join(runtime, composeRuntimeOwnerFile))
	if err != nil {
		return errors.New("ownership_conflict: Edge Runtime function directory has no Fleet owner marker")
	}
	var stored ownerMarker
	if json.Unmarshal(payload, &stored) != nil || stored != marker || stored.Slug != slug {
		return errors.New("ownership_conflict: Edge Runtime function directory belongs to another project binding")
	}
	return nil
}

func copyComposeRevision(source, destination string) error {
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == source {
			return nil
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("ownership_conflict: immutable function revision contains a symlink")
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		target := filepath.Join(destination, relative)
		if entry.IsDir() {
			return os.MkdirAll(target, info.Mode().Perm())
		}
		if !entry.Type().IsRegular() {
			return errors.New("ownership_conflict: immutable function revision contains a non-regular file")
		}
		payload, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, payload, info.Mode().Perm())
	})
}

func projectKey(projectRef string) string {
	digest := sha256.Sum256([]byte(projectRef))
	return hex.EncodeToString(digest[:12])
}
