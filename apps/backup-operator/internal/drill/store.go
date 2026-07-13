package drill

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

var ErrNotFound = errors.New("restore drill result not found")

type FileStore struct {
	Path string
	mu   sync.Mutex
}

func (s *FileStore) Save(_ context.Context, result Result) error {
	if s == nil || !filepath.IsAbs(s.Path) || result.ClusterID == "" || result.Record.ID == "" {
		return errors.New("restore drill file store path and result identity are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	results, err := s.read()
	if err != nil {
		return err
	}
	results[result.ClusterID] = result
	payload, err := json.MarshalIndent(results, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.Path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(s.Path), ".restore-drills-*.tmp")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(0o600); err != nil {
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
	return os.Rename(name, s.Path)
}

func (s *FileStore) Latest(_ context.Context, clusterID string) (Result, error) {
	if s == nil || !filepath.IsAbs(s.Path) || clusterID == "" {
		return Result{}, errors.New("restore drill file store path and cluster are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	results, err := s.read()
	if err != nil {
		return Result{}, err
	}
	result, ok := results[clusterID]
	if !ok {
		return Result{}, ErrNotFound
	}
	return result, nil
}

func (s *FileStore) read() (map[string]Result, error) {
	payload, err := os.ReadFile(s.Path)
	if os.IsNotExist(err) {
		return map[string]Result{}, nil
	}
	if err != nil {
		return nil, err
	}
	var results map[string]Result
	if err := json.Unmarshal(payload, &results); err != nil {
		return nil, err
	}
	if results == nil {
		results = map[string]Result{}
	}
	return results, nil
}
