package drill

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// RecoveryDomainWorkspace enforces an allowlisted, capacity-checked filesystem
// on a different device from production PGDATA.
type RecoveryDomainWorkspace struct {
	Root               string
	AllowedRoots       []string
	ProductionDataPath string
	MinimumFreeBytes   uint64
}

func (w RecoveryDomainWorkspace) Prepare(_ context.Context, path string) error {
	root, err := w.validatedRoot(path)
	if err != nil {
		return err
	}
	if w.MinimumFreeBytes == 0 || w.ProductionDataPath == "" {
		return errors.New("drill workspace requires production path and minimum capacity")
	}
	rootInfo, err := os.Stat(root)
	if err != nil || !rootInfo.IsDir() {
		return errors.New("drill recovery-domain root must be an existing directory")
	}
	productionInfo, err := os.Stat(w.ProductionDataPath)
	if err != nil || !productionInfo.IsDir() {
		return errors.New("production data path must be an existing directory")
	}
	rootStat, rootOK := rootInfo.Sys().(*syscall.Stat_t)
	productionStat, productionOK := productionInfo.Sys().(*syscall.Stat_t)
	if !rootOK || !productionOK || rootStat.Dev == productionStat.Dev {
		return errors.New("drill workspace is not in an independent filesystem recovery domain")
	}
	var fs syscall.Statfs_t
	if err := syscall.Statfs(root, &fs); err != nil {
		return fmt.Errorf("observe drill workspace capacity: %w", err)
	}
	if uint64(fs.Bavail)*uint64(fs.Bsize) < w.MinimumFreeBytes {
		return errors.New("drill workspace has insufficient free capacity")
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return errors.New("drill workspace path must be a real directory")
		}
		entries, err := os.ReadDir(path)
		if err != nil || len(entries) != 0 {
			return errors.New("drill workspace must be empty")
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.Mkdir(path, 0o700)
}

func (w RecoveryDomainWorkspace) Destroy(_ context.Context, path string) error {
	if _, err := w.validatedRoot(path); err != nil {
		return err
	}
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return errors.New("refusing to clean a symlinked drill workspace")
	} else if err != nil && os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}
	return os.RemoveAll(path)
}

func (w RecoveryDomainWorkspace) validatedRoot(path string) (string, error) {
	if !filepath.IsAbs(w.Root) || filepath.Clean(w.Root) != w.Root || !filepath.IsAbs(path) || filepath.Clean(path) != path || filepath.Dir(path) != w.Root {
		return "", errors.New("drill workspace must be a direct child of its absolute recovery-domain root")
	}
	allowed := false
	for _, root := range w.AllowedRoots {
		if filepath.IsAbs(root) && filepath.Clean(root) == root && root == w.Root {
			allowed = true
			break
		}
	}
	if !allowed {
		return "", errors.New("drill recovery-domain root is not allowlisted")
	}
	return w.Root, nil
}
