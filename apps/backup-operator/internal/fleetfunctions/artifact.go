package fleetfunctions

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

type ownerMarker struct {
	ProjectRef string `json:"projectRef"`
	TargetID   string `json:"targetId"`
	BindingID  string `json:"bindingId"`
	Slug       string `json:"slug"`
}

func prepareRevision(root string, request Request) (string, error) {
	marker := ownerMarker{ProjectRef: request.ProjectRef, TargetID: request.TargetID, BindingID: request.BindingID, Slug: request.Deployment.Slug}
	if err := verifyOrCreateOwner(root, marker); err != nil {
		return "", err
	}
	revision := filepath.Join(root, "revisions", request.Deployment.ArtifactDigest)
	bundle, err := ParseBundle(request.Artifact, request.Deployment)
	if err != nil {
		return "", err
	}
	if info, err := os.Stat(revision); err == nil && info.IsDir() {
		if err := verifyRevision(revision, bundle); err != nil {
			return "", err
		}
		return revision, nil
	} else if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	if err := os.MkdirAll(filepath.Join(root, "revisions"), 0o750); err != nil {
		return "", err
	}
	stage, err := os.MkdirTemp(filepath.Join(root, "revisions"), ".stage-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	for _, file := range bundle.Files {
		content, err := base64.StdEncoding.Strict().DecodeString(file.ContentBase64)
		if err != nil {
			return "", err
		}
		path := filepath.Join(stage, filepath.FromSlash(file.Path))
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			return "", err
		}
		mode := fs.FileMode(file.Mode)
		if mode == 0 {
			mode = 0o600
		}
		if err := os.WriteFile(path, content, mode); err != nil {
			return "", err
		}
	}
	if err := os.Rename(stage, revision); err != nil {
		if info, statErr := os.Stat(revision); statErr == nil && info.IsDir() {
			if verifyErr := verifyRevision(revision, bundle); verifyErr != nil {
				return "", verifyErr
			}
			return revision, nil
		}
		return "", err
	}
	return revision, nil
}

func verifyRevision(revision string, bundle Bundle) error {
	expected := make(map[string]BundleFile, len(bundle.Files))
	for _, file := range bundle.Files {
		expected[filepath.Clean(filepath.FromSlash(file.Path))] = file
	}
	seen := make(map[string]struct{}, len(expected))
	err := filepath.WalkDir(revision, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == revision {
			return nil
		}
		relative, err := filepath.Rel(revision, path)
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("ownership_conflict: immutable function revision contains a symlink")
		}
		if entry.IsDir() {
			return nil
		}
		file, ok := expected[relative]
		if !ok || !entry.Type().IsRegular() {
			return errors.New("ownership_conflict: immutable function revision contains an unexpected file")
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		wanted, err := base64.StdEncoding.Strict().DecodeString(file.ContentBase64)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		mode := fs.FileMode(file.Mode)
		if mode == 0 {
			mode = 0o600
		}
		if !bytes.Equal(content, wanted) || info.Mode().Perm() != mode.Perm() {
			return errors.New("ownership_conflict: immutable function revision content changed")
		}
		seen[relative] = struct{}{}
		return nil
	})
	if err != nil {
		return err
	}
	if len(seen) != len(expected) {
		return errors.New("ownership_conflict: immutable function revision is incomplete")
	}
	return nil
}

func verifyOrCreateOwner(root string, marker ownerMarker) error {
	if info, err := os.Lstat(root); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("ownership_conflict: Fleet function path is not an owned directory")
		}
		payload, err := os.ReadFile(filepath.Join(root, ".fleet-function-owner.json"))
		if err != nil {
			return errors.New("ownership_conflict: existing function directory has no Fleet owner marker")
		}
		var stored ownerMarker
		if json.Unmarshal(payload, &stored) != nil || stored != marker {
			return errors.New("ownership_conflict: function directory belongs to another project binding")
		}
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(root, 0o750); err != nil {
		return err
	}
	payload, _ := json.Marshal(marker)
	return os.WriteFile(filepath.Join(root, ".fleet-function-owner.json"), payload, 0o600)
}

func currentDigest(root string) (string, error) {
	target, err := os.Readlink(filepath.Join(root, "current"))
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	digest := filepath.Base(target)
	if !validDigest(digest) || target != filepath.Join("revisions", digest) {
		return "", errors.New("ownership_conflict: current function pointer escapes its immutable revisions")
	}
	return digest, nil
}

func switchPointer(root, digest string) error {
	temporary := filepath.Join(root, ".current-next")
	_ = os.Remove(temporary)
	if digest == "" {
		if err := os.Remove(filepath.Join(root, "current")); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	if err := os.Symlink(filepath.Join("revisions", digest), temporary); err != nil {
		return err
	}
	if err := os.Rename(temporary, filepath.Join(root, "current")); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}
