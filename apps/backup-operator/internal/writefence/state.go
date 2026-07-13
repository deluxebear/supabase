package writefence

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

type AuditEvent struct {
	HandleID string              `json:"handleId"`
	Target   contracts.TargetRef `json:"target"`
	Action   string              `json:"action"`
	State    fenceState          `json:"state"`
	Error    string              `json:"error,omitempty"`
	At       time.Time           `json:"at"`
}

type StateStore interface {
	Load(context.Context) ([]trackedFence, error)
	Save(context.Context, trackedFence) error
	Delete(context.Context, string) error
	AppendAudit(context.Context, AuditEvent) error
}

type stateDocument struct {
	Version int                    `json:"version"`
	Handles map[string]storedFence `json:"handles"`
	Audit   []AuditEvent           `json:"audit"`
}

type storedFence struct {
	Handle   contracts.FenceHandle `json:"handle"`
	State    fenceState            `json:"state"`
	Revision string                `json:"revision"`
}

// FileStateStore is an Agent-local, crash-safe fence state and append-only
// audit store. The enrolled absolute path is never derived from task input.
type FileStateStore struct {
	Path string
	mu   sync.Mutex
}

func (s *FileStateStore) Load(_ context.Context) ([]trackedFence, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	document, err := s.read()
	if err != nil {
		return nil, err
	}
	result := make([]trackedFence, 0, len(document.Handles))
	for id, stored := range document.Handles {
		if id == "" || stored.Handle.ID != id || stored.Handle.Target.ProjectID == "" || stored.Handle.Target.TargetID == "" || stored.State == "" || stored.Revision == "" {
			return nil, errors.New("persisted write fence state is invalid")
		}
		result = append(result, trackedFence{handle: stored.Handle, state: stored.State, revision: stored.Revision})
	}
	return result, nil
}

func (s *FileStateStore) Save(_ context.Context, tracked trackedFence) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	document, err := s.read()
	if err != nil {
		return err
	}
	if document.Handles == nil {
		document.Handles = map[string]storedFence{}
	}
	document.Handles[tracked.handle.ID] = storedFence{Handle: tracked.handle, State: tracked.state, Revision: tracked.revision}
	return s.write(document)
}

func (s *FileStateStore) Delete(_ context.Context, handleID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	document, err := s.read()
	if err != nil {
		return err
	}
	delete(document.Handles, handleID)
	return s.write(document)
}

func (s *FileStateStore) AppendAudit(_ context.Context, event AuditEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	document, err := s.read()
	if err != nil {
		return err
	}
	document.Audit = append(document.Audit, event)
	return s.write(document)
}

func (s *FileStateStore) read() (stateDocument, error) {
	if !filepath.IsAbs(s.Path) || filepath.Clean(s.Path) != s.Path {
		return stateDocument{}, errors.New("write fence state path must be absolute and clean")
	}
	payload, err := os.ReadFile(s.Path)
	if errors.Is(err, os.ErrNotExist) {
		return stateDocument{Version: 1, Handles: map[string]storedFence{}}, nil
	}
	if err != nil {
		return stateDocument{}, err
	}
	if len(payload) > 4<<20 {
		return stateDocument{}, errors.New("write fence state exceeds four MiB")
	}
	var document stateDocument
	if err := json.Unmarshal(payload, &document); err != nil || document.Version != 1 {
		return stateDocument{}, errors.New("write fence state document is invalid")
	}
	return document, nil
}

func (s *FileStateStore) write(document stateDocument) error {
	payload, err := json.Marshal(document)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.Path), 0o700); err != nil {
		return err
	}
	temporary := s.Path + ".tmp"
	if err := os.WriteFile(temporary, payload, 0o600); err != nil {
		return err
	}
	if err := os.Rename(temporary, s.Path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

type ReleaseError struct {
	EntryPoint EntryPoint
	Cause      error
	Runbook    []string
}

func (e *ReleaseError) Error() string {
	return fmt.Sprintf("write fence release failed at %s; traffic remains fail-closed; runbook: %s: %v", e.EntryPoint, strings.Join(e.Runbook, " ; "), e.Cause)
}
func (e *ReleaseError) Unwrap() error { return e.Cause }

type runbookGate interface{ ReleaseRunbook() []string }

func (p *Provider) releaseRunbook(targets map[EntryPoint]Gate, handle contracts.FenceHandle) []string {
	steps := []string{"Do not start PostgreSQL or reopen any writer entry point"}
	for _, entry := range RequiredEntryPoints {
		if gate, ok := targets[entry].(runbookGate); ok {
			steps = append(steps, gate.ReleaseRunbook()...)
		}
	}
	steps = append(steps, "Verify every entry point is blocked, repair the failed control path, then retry fence release for handle "+handle.ID)
	return steps
}

func (p *Provider) save(ctx context.Context, tracked trackedFence, action string, actionErr error) error {
	if p.State == nil {
		return errors.New("durable write fence state store is required")
	}
	if err := p.State.Save(ctx, tracked); err != nil {
		return err
	}
	event := AuditEvent{HandleID: tracked.handle.ID, Target: tracked.handle.Target, Action: action, State: tracked.state, At: p.now()}
	if actionErr != nil {
		event.Error = actionErr.Error()
	}
	return p.State.AppendAudit(ctx, event)
}

// Recover reasserts every persisted fence after an Agent restart. Any
// unverifiable path returns an error while leaving all successfully asserted
// paths blocked.
func (p *Provider) Recover(ctx context.Context) ([]contracts.FenceHandle, error) {
	if p.State == nil {
		return nil, errors.New("durable write fence state store is required")
	}
	tracked, err := p.State.Load(ctx)
	if err != nil {
		return nil, err
	}
	targets, err := p.targets()
	if err != nil {
		return nil, err
	}
	result := make([]contracts.FenceHandle, 0, len(tracked))
	for _, item := range tracked {
		if item.handle.Target != p.Target || item.revision != p.Revision {
			return result, &ReleaseError{Cause: errors.New("persisted write fence target or configuration revision changed"), Runbook: p.releaseRunbook(targets, item.handle)}
		}
		for _, entry := range RequiredEntryPoints {
			if err := targets[entry].Block(ctx, item.handle.Target); err != nil {
				return result, &ReleaseError{EntryPoint: entry, Cause: err, Runbook: p.releaseRunbook(targets, item.handle)}
			}
		}
		if err := p.Database.DrainWriters(ctx); err != nil {
			return result, err
		}
		if err := p.Database.ResolvePreparedTransactions(ctx); err != nil {
			return result, err
		}
		item.handle.Expires = p.now().Add(p.TTL)
		item.state = stateEngaged
		p.mu.Lock()
		if p.handles == nil {
			p.handles = map[string]trackedFence{}
		}
		p.handles[item.handle.ID] = item
		p.mu.Unlock()
		if err := p.save(ctx, item, "recover", nil); err != nil {
			return result, err
		}
		if _, err := p.Verify(ctx, item.handle); err != nil {
			return result, err
		}
		result = append(result, item.handle)
	}
	return result, nil
}
