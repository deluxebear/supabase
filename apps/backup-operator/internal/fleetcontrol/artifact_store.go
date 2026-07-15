package fleetcontrol

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/supabase/supabase/apps/backup-operator/internal/fleetfunctions"
)

type ArtifactStore struct {
	Root  string
	Store *Store
}

func (s *ArtifactStore) Put(ctx context.Context, projectRef, digest string, raw []byte, actor, correlationID string) (bool, error) {
	if s == nil || s.Store == nil || strings.TrimSpace(s.Root) == "" || projectRef == "" || actor == "" || correlationID == "" || len(raw) == 0 || len(raw) > fleetfunctions.MaxArtifactBytes {
		return false, errors.New("complete bounded function artifact is required")
	}
	computed := sha256.Sum256(raw)
	if hex.EncodeToString(computed[:]) != digest {
		return false, errors.New("function artifact digest does not match request")
	}
	path := s.path(projectRef, digest)
	if existingSize, exists, err := s.Store.GetFunctionArtifact(ctx, projectRef, digest); err != nil {
		return false, err
	} else if !exists {
		if err := s.Store.CheckArtifactQuota(ctx, projectRef, int64(len(raw))); err != nil {
			return false, err
		}
	} else if existingSize != int64(len(raw)) {
		return false, errors.New("immutable function artifact metadata conflict")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return false, err
	}
	if existing, err := os.ReadFile(path); err == nil {
		if !bytes.Equal(existing, raw) {
			return false, errors.New("immutable function artifact content conflict")
		}
		if err := s.Store.RegisterFunctionArtifact(ctx, projectRef, digest, int64(len(raw)), actor, correlationID); err != nil {
			return false, err
		}
		return false, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return false, err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".artifact-*")
	if err != nil {
		return false, err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return false, err
	}
	if _, err := temporary.Write(raw); err != nil {
		temporary.Close()
		return false, err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return false, err
	}
	if err := temporary.Close(); err != nil {
		return false, err
	}
	if err := os.Rename(temporaryName, path); err != nil {
		return false, err
	}
	if err := s.Store.RegisterFunctionArtifact(ctx, projectRef, digest, int64(len(raw)), actor, correlationID); err != nil {
		return false, err
	}
	return true, nil
}

func (s *ArtifactStore) Open(ctx context.Context, projectRef, digest string) (io.ReadCloser, int64, error) {
	if s == nil || s.Store == nil || projectRef == "" || !validArtifactDigest(digest) {
		return nil, 0, ErrArtifactNotFound
	}
	size, ok, err := s.Store.GetFunctionArtifact(ctx, projectRef, digest)
	if err != nil || !ok {
		return nil, 0, ErrArtifactNotFound
	}
	file, err := os.Open(s.path(projectRef, digest))
	if err != nil {
		return nil, 0, err
	}
	return file, size, nil
}

func validArtifactDigest(value string) bool {
	if len(value) != sha256.Size*2 || strings.ToLower(value) != value {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func (s *ArtifactStore) path(projectRef, digest string) string {
	projectDigest := sha256.Sum256([]byte(projectRef))
	return filepath.Join(s.Root, hex.EncodeToString(projectDigest[:]), digest+".bundle.json")
}
