package pgbackrest

import (
	"context"
	"errors"
	"os"
	"path/filepath"
)

type FileConfigStore struct {
	Path       string
	AllowedDir string
}

func (s FileConfigStore) ApplyAtomic(_ context.Context, content []byte) (func(context.Context) error, error) {
	allowed, err := filepath.Abs(s.AllowedDir)
	if err != nil {
		return nil, err
	}
	target, err := filepath.Abs(s.Path)
	if err != nil {
		return nil, err
	}
	if filepath.Dir(target) != allowed || filepath.Ext(target) != ".conf" {
		return nil, errors.New("configuration target is outside the enrolled conf.d directory")
	}
	old, readErr := os.ReadFile(target)
	if readErr != nil && !os.IsNotExist(readErr) {
		return nil, readErr
	}
	hadOld := readErr == nil
	if err := atomicWrite(target, content); err != nil {
		return nil, err
	}
	rollback := func(context.Context) error {
		if hadOld {
			return atomicWrite(target, old)
		}
		return os.Remove(target)
	}
	return rollback, nil
}

func atomicWrite(target string, content []byte) error {
	temporary, err := os.CreateTemp(filepath.Dir(target), ".pgbackrest-*.tmp")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(0o640); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(content); err != nil {
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
	if err := os.Rename(name, target); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(target))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
