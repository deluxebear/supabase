package pgbackrest

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestFileConfigStoreAtomicApplyAndRollback(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "supabase.conf")
	if err := os.WriteFile(path, []byte("old"), 0o640); err != nil {
		t.Fatal(err)
	}
	rollback, err := (FileConfigStore{Path: path, AllowedDir: dir}).ApplyAtomic(context.Background(), []byte("new"))
	if err != nil {
		t.Fatal(err)
	}
	if content, _ := os.ReadFile(path); string(content) != "new" {
		t.Fatalf("apply content: %q", content)
	}
	if err := rollback(context.Background()); err != nil {
		t.Fatal(err)
	}
	if content, _ := os.ReadFile(path); string(content) != "old" {
		t.Fatalf("rollback content: %q", content)
	}
	if _, err := (FileConfigStore{Path: filepath.Join(dir, "..", "escape.conf"), AllowedDir: dir}).ApplyAtomic(context.Background(), []byte("bad")); err == nil {
		t.Fatal("path escape accepted")
	}
}
