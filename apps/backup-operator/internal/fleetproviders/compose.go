package fleetproviders

import (
	"context"
	"crypto/ecdh"
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

	"github.com/supabase/supabase/apps/backup-operator/internal/sealedsecret"
)

const (
	composeOwnerFile = ".fleet-owner.json"
	// composeBootstrapFile marks a domain directory that the target's init
	// step created so Compose can always load `current/`, before any Fleet
	// binding has claimed it. The first applied revision claims it.
	composeBootstrapFile = ".fleet-bootstrap.json"
	// composeRolloutMarker records the revision whose rollout completed, so a
	// revision written just before a crash is not reported as applied.
	composeRolloutMarker = ".fleet-rolled-out"
)

// Rollouter recreates one Compose service and returns once it is healthy.
type Rollouter interface {
	Rollout(ctx context.Context, service string) error
}

type ComposeProvider struct {
	OwnedRoot string
	Rollout   Rollouter
	// SecretRecipient opens sealed files. Without it, documents with sealed
	// files fail before anything is written.
	SecretRecipient *ecdh.PrivateKey
	// SecretGroupID, when positive, owns sealed files (mode 0640) and their
	// revision directories, so operators in that group can run `docker compose`.
	SecretGroupID int
}

// materializedFile is a Compose file ready to write: plain content as given,
// or sealed content decrypted for this project, binding, domain, and path.
type materializedFile struct {
	Path         string
	Content      []byte
	Mode         fs.FileMode
	SealedDigest string
}

const sealedDigestDirectory = ".fleet-sealed"

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
	rollout := request.Document.Compose.Rollout
	if len(rollout) > 0 && p.Rollout == nil {
		return Evidence{}, errors.New("rollout_unavailable: the Compose configuration requires a service rollout, but no lifecycle runtime is configured on this Agent")
	}
	if inSync && (len(rollout) == 0 || rolledOut(domainRoot, current.ActiveRevision)) {
		return NewEvidence(request, current, "in-sync", false, nil)
	}
	previous := current.ActiveRevision
	changedFiles := !inSync
	if changedFiles {
		files, err := p.materialize(request)
		if err != nil {
			return Evidence{}, err
		}
		if err := applyComposeRevision(domainRoot, owner, request.DesiredDigest, files, p.SecretGroupID); err != nil {
			return Evidence{}, err
		}
	}
	if len(rollout) > 0 {
		revision := current.ActiveRevision
		if changedFiles {
			revision = request.DesiredDigest
		}
		if err := p.rolloutServices(ctx, domainRoot, rollout, revision); err != nil {
			return Evidence{}, p.recover(ctx, domainRoot, previous, changedFiles, rollout, err)
		}
	}
	observed, err := observeCompose(domainRoot, request.Document.Compose.Files)
	if err != nil {
		return Evidence{}, err
	}
	return NewEvidence(request, observed, "in-sync", true, nil)
}

// materialize decrypts sealed files. It runs before anything is written, so
// an envelope sealed to another key or another context changes nothing.
func (p ComposeProvider) materialize(request Request) ([]materializedFile, error) {
	files := make([]materializedFile, 0, len(request.Document.Compose.Files))
	for _, file := range request.Document.Compose.Files {
		mode := fs.FileMode(file.Mode)
		if file.Sealed == nil {
			if mode == 0 {
				mode = 0o600
			}
			files = append(files, materializedFile{Path: file.Path, Content: []byte(file.Content), Mode: mode})
			continue
		}
		if p.SecretRecipient == nil {
			return nil, errors.New("sealed_secret_unavailable: this Agent has no secret recipient key")
		}
		plaintext, err := sealedsecret.Open(p.SecretRecipient, sealedsecret.Context{
			ProjectRef: request.ProjectRef, BindingID: request.BindingID, Domain: request.Domain, Path: file.Path,
		}, file.Sealed.Envelope)
		if err != nil {
			return nil, err
		}
		if mode == 0 {
			mode = 0o640
		}
		files = append(files, materializedFile{Path: file.Path, Content: plaintext, Mode: mode, SealedDigest: sealedsecret.Digest(file.Sealed.Envelope)})
	}
	return files, nil
}

func sealedDigestPath(root, filePath string) string {
	return filepath.Join(root, sealedDigestDirectory, strings.ReplaceAll(filePath, "/", "__")+".digest")
}

func (p ComposeProvider) rolloutServices(ctx context.Context, domainRoot string, services []string, revision string) error {
	for _, service := range services {
		if err := p.Rollout.Rollout(ctx, service); err != nil {
			return fmt.Errorf("rollout %s: %w", service, err)
		}
	}
	return writeAtomic(filepath.Join(domainRoot, composeRolloutMarker), []byte(revision), 0o600)
}

// recover restores the previous revision after a failed rollout and converges
// the services back onto it. It always returns an error: the desired revision
// was not applied.
func (p ComposeProvider) recover(ctx context.Context, domainRoot, previous string, changedFiles bool, services []string, cause error) error {
	if !changedFiles || previous == "" {
		return fmt.Errorf("manual_intervention_required: %w; no earlier Fleet revision exists to restore", cause)
	}
	if err := pointCurrent(domainRoot, previous); err != nil {
		return fmt.Errorf("manual_intervention_required: %w; restoring revision %s failed: %v", cause, previous, err)
	}
	for _, service := range services {
		if err := p.Rollout.Rollout(ctx, service); err != nil {
			return fmt.Errorf("manual_intervention_required: %w; %s did not recover on revision %s: %v", cause, service, previous, err)
		}
	}
	if err := writeAtomic(filepath.Join(domainRoot, composeRolloutMarker), []byte(previous), 0o600); err != nil {
		return fmt.Errorf("manual_intervention_required: %w; recording the restored revision failed: %v", cause, err)
	}
	return fmt.Errorf("rollout_failed: %w; restored revision %s", cause, previous)
}

func rolledOut(domainRoot, revision string) bool {
	if revision == "" {
		return false
	}
	payload, err := os.ReadFile(filepath.Join(domainRoot, composeRolloutMarker))
	return err == nil && string(payload) == revision
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
		if len(entries) == 0 || isUnclaimedBootstrap(domainRoot, wanted.Domain, entries) {
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

// isUnclaimedBootstrap accepts a directory that holds only the init step's
// bootstrap marker, revisions, and current pointer for the wanted domain.
func isUnclaimedBootstrap(domainRoot, domain string, entries []fs.DirEntry) bool {
	var marker struct {
		Domain string `json:"domain"`
	}
	payload, err := os.ReadFile(filepath.Join(domainRoot, composeBootstrapFile))
	if err != nil || json.Unmarshal(payload, &marker) != nil || marker.Domain != domain {
		return false
	}
	for _, entry := range entries {
		switch entry.Name() {
		case composeBootstrapFile, composeRolloutMarker, "current", "revisions":
		default:
			return false
		}
	}
	return true
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
		if file.Sealed != nil {
			// Never digest sealed plaintext: report which envelope produced it.
			if _, err := os.Stat(path); errors.Is(err, fs.ErrNotExist) {
				observation.Files[file.Path] = "missing"
				continue
			} else if err != nil {
				return observation, err
			}
			recorded, err := os.ReadFile(sealedDigestPath(filepath.Join(domainRoot, "current"), file.Path))
			if err != nil {
				observation.Files[file.Path] = "sealed:unknown"
				continue
			}
			observation.Files[file.Path] = "sealed:" + strings.TrimSpace(string(recorded))
			continue
		}
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
		if file.Sealed != nil {
			result[file.Path] = "sealed:" + sealedsecret.Digest(file.Sealed.Envelope)
			continue
		}
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

func applyComposeRevision(domainRoot string, owner composeOwner, revision string, files []materializedFile, secretGroupID int) error {
	// Operators run `docker compose` on the host as their own user, so a
	// revision whose files are all world-readable gets traversable directories.
	// Revisions holding restricted files keep group-only directories, owned by
	// the operator group when one is configured.
	dirMode := fs.FileMode(0o750)
	if allWorldReadable(files) {
		dirMode = 0o755
	}
	hasSealed := false
	for _, file := range files {
		hasSealed = hasSealed || file.SealedDigest != ""
	}
	shareWithGroup := func(path string) error {
		if !hasSealed || secretGroupID <= 0 {
			return nil
		}
		return os.Chown(path, -1, secretGroupID)
	}
	if err := os.MkdirAll(domainRoot, dirMode); err != nil {
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
	if err := os.MkdirAll(revisionRoot, dirMode); err != nil {
		return err
	}
	// MkdirAll applies the umask and leaves existing directories alone.
	if err := os.Chmod(revisionRoot, dirMode); err != nil {
		return err
	}
	for _, directory := range []string{domainRoot, filepath.Join(domainRoot, "revisions"), revisionRoot} {
		if err := shareWithGroup(directory); err != nil {
			return fmt.Errorf("share Fleet revision with the operator group: %w", err)
		}
	}
	for _, file := range files {
		path := filepath.Join(revisionRoot, filepath.FromSlash(file.Path))
		if !strings.HasPrefix(path, revisionRoot+string(filepath.Separator)) {
			return errors.New("Compose file escaped the Fleet revision directory")
		}
		if err := os.MkdirAll(filepath.Dir(path), dirMode); err != nil {
			return err
		}
		if err := writeAtomic(path, file.Content, file.Mode); err != nil {
			return err
		}
		if file.SealedDigest == "" {
			continue
		}
		if err := shareWithGroup(path); err != nil {
			return fmt.Errorf("share sealed file with the operator group: %w", err)
		}
		digestPath := sealedDigestPath(revisionRoot, file.Path)
		if err := os.MkdirAll(filepath.Dir(digestPath), 0o700); err != nil {
			return err
		}
		if err := writeAtomic(digestPath, []byte(file.SealedDigest), 0o600); err != nil {
			return err
		}
	}
	return pointCurrent(domainRoot, revision)
}

func allWorldReadable(files []materializedFile) bool {
	for _, file := range files {
		if file.Mode != 0o644 {
			return false
		}
	}
	return len(files) > 0
}

// pointCurrent atomically points current/ at revisions/<revision>.
func pointCurrent(domainRoot, revision string) error {
	if revision == "" || strings.ContainsAny(revision, `/\`) || revision == "." || revision == ".." {
		return errors.New("invalid Compose revision name")
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
