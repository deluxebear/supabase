package fleetproviders

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const composeOwnerFile = ".fleet-owner.json"

type ComposeProvider struct {
	OwnedRoot string
}

type composeOwner struct {
	ProjectRef string `json:"projectRef"`
	TargetID   string `json:"targetId"`
	BindingID  string `json:"bindingId"`
	Domain     string `json:"domain"`
}

type composeObservation struct {
	ActiveRevision string            `json:"activeRevision,omitempty"`
	Files          map[string]string `json:"files"`
	PatchDigest    string            `json:"patchDigest,omitempty"`
}

func (ComposeProvider) Adapter() AdapterKind { return AdapterCompose }

func (p ComposeProvider) Reconcile(ctx context.Context, request Request) (Evidence, error) {
	if err := request.Validate(); err != nil {
		return Evidence{}, err
	}
	if request.Document.Adapter != AdapterCompose || strings.TrimSpace(p.OwnedRoot) == "" {
		return Evidence{}, errors.New("Compose provider is not configured")
	}
	select {
	case <-ctx.Done():
		return Evidence{}, ctx.Err()
	default:
	}
	domainRoot := filepath.Join(p.OwnedRoot, safeSegment(request.Domain))
	owner := composeOwner{ProjectRef: request.ProjectRef, TargetID: request.TargetID, BindingID: request.BindingID, Domain: request.Domain}
	conflicts, err := verifyComposeOwnership(domainRoot, owner)
	if err != nil {
		return Evidence{}, err
	}
	if len(conflicts) > 0 {
		evidence, evidenceErr := NewEvidence(request, composeObservation{Files: map[string]string{}}, "ownership-conflict", false, conflicts)
		if evidenceErr != nil {
			return Evidence{}, evidenceErr
		}
		return evidence, &OwnershipConflictError{Conflicts: conflicts}
	}
	current, err := observeCompose(domainRoot, request.Document.Compose.Files)
	if err != nil {
		return Evidence{}, err
	}
	desired := composeDigests(request.Document.Compose.Files)
	inSync := sameDigests(current.Files, desired)
	if request.ObservationOnly || request.Document.OwnershipMode == ObserveOnly || request.Document.OwnershipMode == GitOpsManaged {
		state := "in-sync"
		if !inSync {
			state = "drifted"
		}
		if request.Document.OwnershipMode == GitOpsManaged {
			current.PatchDigest = digestMap(desired)
		}
		return NewEvidence(request, current, state, false, nil)
	}
	if inSync {
		return NewEvidence(request, current, "in-sync", false, nil)
	}
	if err := applyComposeRevision(domainRoot, owner, request.DesiredDigest, request.Document.Compose.Files); err != nil {
		return Evidence{}, err
	}
	observed, err := observeCompose(domainRoot, request.Document.Compose.Files)
	if err != nil {
		return Evidence{}, err
	}
	return NewEvidence(request, observed, "in-sync", true, nil)
}

func verifyComposeOwnership(domainRoot string, wanted composeOwner) ([]Conflict, error) {
	info, err := os.Lstat(domainRoot)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return []Conflict{composeConflict(domainRoot, "The configured Fleet-owned Compose path is not a directory")}, nil
	}
	payload, err := os.ReadFile(filepath.Join(domainRoot, composeOwnerFile))
	if errors.Is(err, fs.ErrNotExist) {
		entries, readErr := os.ReadDir(domainRoot)
		if readErr != nil {
			return nil, readErr
		}
		if len(entries) == 0 {
			return nil, nil
		}
		return []Conflict{composeConflict(domainRoot, "The Compose directory contains files not owned by Fleet")}, nil
	}
	if err != nil {
		return nil, err
	}
	var stored composeOwner
	if json.Unmarshal(payload, &stored) != nil || stored != wanted {
		return []Conflict{composeConflict(domainRoot, "The Compose directory belongs to a different project, target, binding, or domain")}, nil
	}
	return nil, nil
}

func composeConflict(resource, message string) Conflict {
	return Conflict{Code: "ownership_conflict", Resource: resource, Message: message, Remediation: "Choose an empty Fleet-owned directory or restore its matching ownership marker; do not point Fleet at a user-owned Compose checkout."}
}

func observeCompose(domainRoot string, files []ComposeFile) (composeObservation, error) {
	observation := composeObservation{Files: make(map[string]string, len(files))}
	active, err := os.Readlink(filepath.Join(domainRoot, "current"))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return observation, err
	}
	if err == nil {
		observation.ActiveRevision = filepath.Base(active)
	}
	for _, file := range files {
		path := filepath.Join(domainRoot, "current", filepath.FromSlash(file.Path))
		payload, err := os.ReadFile(path)
		if errors.Is(err, fs.ErrNotExist) {
			observation.Files[file.Path] = "missing"
			continue
		}
		if err != nil {
			return observation, err
		}
		digest := sha256.Sum256(payload)
		observation.Files[file.Path] = hex.EncodeToString(digest[:])
	}
	return observation, nil
}

func composeDigests(files []ComposeFile) map[string]string {
	result := make(map[string]string, len(files))
	for _, file := range files {
		digest := sha256.Sum256([]byte(file.Content))
		result[file.Path] = hex.EncodeToString(digest[:])
	}
	return result
}

func sameDigests(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if right[key] != value {
			return false
		}
	}
	return true
}

func digestMap(values map[string]string) string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	hash := sha256.New()
	for _, key := range keys {
		_, _ = fmt.Fprintf(hash, "%s=%s\n", key, values[key])
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func applyComposeRevision(domainRoot string, owner composeOwner, revision string, files []ComposeFile) error {
	if err := os.MkdirAll(domainRoot, 0o750); err != nil {
		return err
	}
	ownerPayload, err := json.Marshal(owner)
	if err != nil {
		return err
	}
	ownerPath := filepath.Join(domainRoot, composeOwnerFile)
	if _, err := os.Stat(ownerPath); errors.Is(err, fs.ErrNotExist) {
		if err := writeAtomic(ownerPath, ownerPayload, 0o600); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	revisionRoot := filepath.Join(domainRoot, "revisions", revision)
	if err := os.MkdirAll(revisionRoot, 0o750); err != nil {
		return err
	}
	for _, file := range files {
		path := filepath.Join(revisionRoot, filepath.FromSlash(file.Path))
		if !strings.HasPrefix(path, revisionRoot+string(filepath.Separator)) {
			return errors.New("Compose file escaped the Fleet revision directory")
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			return err
		}
		mode := fs.FileMode(file.Mode)
		if mode == 0 {
			mode = 0o600
		}
		if err := writeAtomic(path, []byte(file.Content), mode); err != nil {
			return err
		}
	}
	temporaryLink := filepath.Join(domainRoot, ".current-"+revision)
	_ = os.Remove(temporaryLink)
	if err := os.Symlink(filepath.Join("revisions", revision), temporaryLink); err != nil {
		return err
	}
	if err := os.Rename(temporaryLink, filepath.Join(domainRoot, "current")); err != nil {
		_ = os.Remove(temporaryLink)
		return err
	}
	return nil
}

func writeAtomic(path string, payload []byte, mode fs.FileMode) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".fleet-write-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(payload); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryName, path)
}

func safeSegment(value string) string {
	return strings.NewReplacer("/", "_", "\\", "_", "..", "_").Replace(value)
}
