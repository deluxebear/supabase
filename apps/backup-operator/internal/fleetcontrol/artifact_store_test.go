package fleetcontrol

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"path/filepath"
	"testing"
)

func TestFunctionArtifactStoreIsImmutableAndProjectIsolated(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "control"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	artifacts := &ArtifactStore{Root: filepath.Join(t.TempDir(), "artifacts"), Store: store}
	raw := []byte(`{"schema":"supabase.fleet.functions.bundle.v1","files":[]}`)
	digestBytes := sha256.Sum256(raw)
	digest := hex.EncodeToString(digestBytes[:])
	created, err := artifacts.Put(ctx, "project-a", digest, raw, "user-a", "request-a")
	if err != nil || !created {
		t.Fatalf("put artifact = %v, %v", created, err)
	}
	created, err = artifacts.Put(ctx, "project-a", digest, raw, "user-a", "request-replay")
	if err != nil || created {
		t.Fatalf("idempotent put = %v, %v", created, err)
	}
	reader, size, err := artifacts.Open(ctx, "project-a", digest)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	stored, err := io.ReadAll(reader)
	if err != nil || size != int64(len(raw)) || string(stored) != string(raw) {
		t.Fatalf("stored artifact = %q size=%d err=%v", stored, size, err)
	}
	if _, _, err := artifacts.Open(ctx, "project-b", digest); !errors.Is(err, ErrArtifactNotFound) {
		t.Fatalf("cross-project artifact read = %v", err)
	}
	if _, _, err := artifacts.Open(ctx, "project-a", "../../outside"); !errors.Is(err, ErrArtifactNotFound) {
		t.Fatalf("invalid digest artifact read = %v", err)
	}
	if _, err := artifacts.Put(ctx, "project-a", digest, append(raw, 'x'), "user-a", "request-bad"); err == nil {
		t.Fatal("digest mutation was accepted")
	}
}
