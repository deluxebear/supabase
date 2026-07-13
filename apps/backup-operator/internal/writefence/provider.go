package writefence

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

type Gate interface {
	Block(context.Context, contracts.TargetRef) error
	Blocked(context.Context, contracts.TargetRef) (bool, error)
	Unblock(context.Context, contracts.TargetRef) error
}

type EntryPoint string

const (
	EntryKongDataPlane EntryPoint = "kong-data-plane"
	EntrySupavisor     EntryPoint = "supavisor"
	EntryAuth          EntryPoint = "auth"
	EntryStorage       EntryPoint = "storage"
	EntryRealtime      EntryPoint = "realtime"
	EntryBackground    EntryPoint = "background-jobs"
	EntryDirectPG      EntryPoint = "direct-postgres"
)

var RequiredEntryPoints = [...]EntryPoint{EntryKongDataPlane, EntrySupavisor, EntryAuth, EntryStorage, EntryRealtime, EntryBackground, EntryDirectPG}

type fenceState string

const (
	stateEngaging      fenceState = "engaging"
	stateEngaged       fenceState = "engaged"
	stateVerified      fenceState = "verified"
	stateReleaseFailed fenceState = "release-failed"
)

type trackedFence struct {
	handle   contracts.FenceHandle
	state    fenceState
	revision string
}

type DatabaseFence interface {
	DrainWriters(context.Context) error
	ResolvePreparedTransactions(context.Context) error
	ActiveWriters(context.Context) (int, error)
	PreparedTransactions(context.Context) (int, error)
	Healthy(context.Context) error
}

type Provider struct {
	ProviderID  string
	Revision    string
	Target      contracts.TargetRef
	EntryPoints map[EntryPoint]Gate
	Database    DatabaseFence
	Topology    contracts.TopologyProvider
	State       StateStore
	TTL         time.Duration
	Now         func() time.Time

	mu      sync.Mutex
	handles map[string]trackedFence
}

func (p *Provider) ID() string { return p.ProviderID }

// Capabilities proves that every enrolled Supabase write entry point and the
// independent database control channel are observable. Missing or ambiguous
// status blocks destructive restore before a plan can be authorized.
func (p *Provider) Capabilities(ctx context.Context, target contracts.TargetRef) (contracts.Evidence, error) {
	now := p.now()
	if p.Revision == "" || target != p.Target {
		return contracts.Evidence{}, errors.New("write fence target and configuration revision are not enrolled")
	}
	targets, err := p.targets()
	if err != nil {
		return contracts.Evidence{}, err
	}
	facts := make(map[string]string, len(targets))
	for _, entry := range RequiredEntryPoints {
		if _, err := targets[entry].Blocked(ctx, target); err != nil {
			return contracts.Evidence{}, fmt.Errorf("verify %s control path: %w", entry, err)
		}
		facts["entrypoint."+string(entry)+".observable"] = "true"
		facts["entrypoint."+string(entry)+".observation"] = p.Revision + ":" + string(entry)
	}
	if err := p.Database.Healthy(ctx); err != nil {
		return contracts.Evidence{}, fmt.Errorf("verify database control channel: %w", err)
	}
	if _, err := p.Topology.Observe(ctx, target); err != nil {
		return contracts.Evidence{}, fmt.Errorf("verify topology for write fence: %w", err)
	}
	facts["config_revision"] = p.Revision
	return contracts.Evidence{ProviderID: p.ProviderID, ObservationID: "write-fence-" + p.Revision, ObservedAt: now, ValidUntil: now.Add(30 * time.Second), Facts: facts}, nil
}

func (p *Provider) Engage(ctx context.Context, target contracts.TargetRef, topology contracts.TopologySnapshot) (contracts.FenceHandle, error) {
	now := p.now()
	if p.ProviderID == "" || p.Revision == "" || target != p.Target || p.Database == nil || p.Topology == nil || p.TTL <= 0 {
		return contracts.FenceHandle{}, errors.New("write fence provider is incomplete")
	}
	targets, err := p.targets()
	if err != nil {
		return contracts.FenceHandle{}, err
	}
	if err := topology.ValidateForDestructive(now); err != nil {
		return contracts.FenceHandle{}, err
	}
	id, err := randomID()
	if err != nil {
		return contracts.FenceHandle{}, err
	}
	handle := contracts.FenceHandle{ID: id, Target: target, Expires: now.Add(p.TTL)}
	tracked := trackedFence{handle: handle, state: stateEngaging, revision: p.Revision}
	if err := p.save(ctx, tracked, "engaging", nil); err != nil {
		return contracts.FenceHandle{}, fmt.Errorf("persist write fence intent: %w", err)
	}
	blocked := make([]Gate, 0, len(targets))
	for _, entry := range RequiredEntryPoints {
		gate := targets[entry]
		if err := gate.Block(ctx, target); err != nil {
			return contracts.FenceHandle{}, p.compensateEngage(ctx, tracked, targets, blocked, entry, fmt.Errorf("block %s traffic gate: %w", entry, err))
		}
		blocked = append(blocked, gate)
	}
	if err := p.Database.DrainWriters(ctx); err != nil {
		return contracts.FenceHandle{}, p.compensateEngage(ctx, tracked, targets, blocked, "", fmt.Errorf("drain writers: %w", err))
	}
	if err := p.Database.ResolvePreparedTransactions(ctx); err != nil {
		return contracts.FenceHandle{}, p.compensateEngage(ctx, tracked, targets, blocked, "", fmt.Errorf("prepared transaction preflight: %w", err))
	}
	tracked.state = stateEngaged
	if err := p.save(ctx, tracked, "engage", nil); err != nil {
		// The fence is already closed. Persistence failure must remain fail-closed;
		// do not reopen any writer path.
		return contracts.FenceHandle{}, fmt.Errorf("persist engaged write fence (traffic remains blocked): %w", err)
	}
	p.mu.Lock()
	if p.handles == nil {
		p.handles = make(map[string]trackedFence)
	}
	p.handles[id] = tracked
	p.mu.Unlock()
	return handle, nil
}

func (p *Provider) Verify(ctx context.Context, handle contracts.FenceHandle) (contracts.FenceEvidence, error) {
	if !p.known(handle) {
		return contracts.FenceEvidence{}, errors.New("unknown write fence handle")
	}
	now := p.now()
	targets, err := p.targets()
	if err != nil {
		return contracts.FenceEvidence{}, err
	}
	blocked := map[EntryPoint]bool{}
	for _, entry := range RequiredEntryPoints {
		value, checkErr := targets[entry].Blocked(ctx, handle.Target)
		if checkErr != nil {
			return contracts.FenceEvidence{}, fmt.Errorf("verify %s fence target: %w", entry, checkErr)
		}
		blocked[entry] = value
	}
	writers, err := p.Database.ActiveWriters(ctx)
	if err != nil {
		return contracts.FenceEvidence{}, err
	}
	prepared, err := p.Database.PreparedTransactions(ctx)
	if err != nil {
		return contracts.FenceEvidence{}, err
	}
	snapshot, err := p.Topology.Observe(ctx, handle.Target)
	if err != nil {
		return contracts.FenceEvidence{}, err
	}
	primaries := 0
	for _, node := range snapshot.Nodes {
		if node.Reachable && node.Role == contracts.RolePrimary {
			primaries++
		}
	}
	controlHealthy := p.Database.Healthy(ctx) == nil
	facts := map[string]string{"topology_observation": snapshot.Evidence.ObservationID}
	allServicesBlocked := true
	for _, entry := range RequiredEntryPoints {
		facts["entrypoint."+string(entry)+".blocked"] = fmt.Sprintf("%t", blocked[entry])
		if entry == EntryAuth || entry == EntryStorage || entry == EntryRealtime || entry == EntryBackground {
			allServicesBlocked = allServicesBlocked && blocked[entry]
		}
	}
	evidence := contracts.FenceEvidence{
		Evidence: contracts.Evidence{
			ProviderID: p.ProviderID, ObservationID: handle.ID, ObservedAt: now,
			ValidUntil: minTime(handle.Expires, now.Add(30*time.Second)),
			Facts:      facts,
		},
		DataPlaneBlocked: blocked[EntryKongDataPlane], PoolersBlocked: blocked[EntrySupavisor], DirectLoginBlocked: blocked[EntryDirectPG],
		ActiveWriters: writers, PreparedTransactions: prepared, AlternatePrimaries: max(0, primaries-1),
		ControlChannelHealthy: controlHealthy,
	}
	if err := evidence.Validate(now); err != nil {
		return evidence, fmt.Errorf("%w (data_plane=%t poolers=%t direct_logins=%t control_channel=%t active_writers=%d prepared_transactions=%d alternate_primaries=%d)", err, evidence.DataPlaneBlocked, evidence.PoolersBlocked, evidence.DirectLoginBlocked, evidence.ControlChannelHealthy, evidence.ActiveWriters, evidence.PreparedTransactions, evidence.AlternatePrimaries)
	}
	if !allServicesBlocked {
		return evidence, contracts.ErrFenceIncomplete
	}
	p.mu.Lock()
	tracked := p.handles[handle.ID]
	tracked.state = stateVerified
	p.handles[handle.ID] = tracked
	p.mu.Unlock()
	if err := p.save(ctx, tracked, "verify", nil); err != nil {
		return evidence, fmt.Errorf("persist verified write fence: %w", err)
	}
	return evidence, nil
}

func (p *Provider) Refresh(ctx context.Context, handle contracts.FenceHandle) (contracts.FenceHandle, error) {
	if _, err := p.Verify(ctx, handle); err != nil {
		return contracts.FenceHandle{}, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	tracked, ok := p.handles[handle.ID]
	if !ok {
		return contracts.FenceHandle{}, errors.New("unknown write fence handle")
	}
	tracked.handle.Expires = p.now().Add(p.TTL)
	p.handles[handle.ID] = tracked
	if err := p.save(ctx, tracked, "refresh", nil); err != nil {
		return contracts.FenceHandle{}, err
	}
	return tracked.handle, nil
}

// Resume returns and refreshes the exact durable fence established by the
// forward recovery. Rollback must not create a second handle because the
// original execution is cryptographically and operationally bound to this ID.
func (p *Provider) Resume(ctx context.Context, handleID string, target contracts.TargetRef) (contracts.FenceHandle, error) {
	p.mu.Lock()
	tracked, ok := p.handles[handleID]
	p.mu.Unlock()
	if !ok || tracked.handle.Target != target || tracked.revision != p.Revision {
		return contracts.FenceHandle{}, errors.New("durable write fence handle is unavailable or changed")
	}
	return p.Refresh(ctx, tracked.handle)
}

func (p *Provider) Release(ctx context.Context, handle contracts.FenceHandle) (contracts.Evidence, error) {
	if !p.known(handle) {
		return contracts.Evidence{}, errors.New("unknown write fence handle")
	}
	targets, err := p.targets()
	if err != nil {
		return contracts.Evidence{}, err
	}
	released := make([]Gate, 0, len(targets))
	for i := len(RequiredEntryPoints) - 1; i >= 0; i-- {
		entry := RequiredEntryPoints[i]
		gate := targets[entry]
		if err := gate.Unblock(ctx, handle.Target); err != nil {
			var reblockErr error
			for j := len(released) - 1; j >= 0; j-- {
				reblockErr = errors.Join(reblockErr, released[j].Block(context.WithoutCancel(ctx), handle.Target))
			}
			p.mu.Lock()
			tracked := p.handles[handle.ID]
			tracked.state = stateReleaseFailed
			p.handles[handle.ID] = tracked
			p.mu.Unlock()
			failure := errors.Join(err, reblockErr)
			_ = p.save(context.WithoutCancel(ctx), tracked, "release-failed", failure)
			return contracts.Evidence{}, &ReleaseError{EntryPoint: entry, Cause: failure, Runbook: p.releaseRunbook(targets, handle)}
		}
		released = append(released, gate)
	}
	p.mu.Lock()
	delete(p.handles, handle.ID)
	p.mu.Unlock()
	if p.State != nil {
		if err := p.State.Delete(ctx, handle.ID); err != nil {
			return contracts.Evidence{}, fmt.Errorf("persist write fence release: %w", err)
		}
	}
	now := p.now()
	return contracts.Evidence{ProviderID: p.ProviderID, ObservationID: handle.ID + "-released", ObservedAt: now, ValidUntil: now.Add(30 * time.Second)}, nil
}

func (p *Provider) known(handle contracts.FenceHandle) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	known, ok := p.handles[handle.ID]
	return ok && known.handle.Target == handle.Target && known.handle.Expires.Equal(handle.Expires)
}

func (p *Provider) targets() (map[EntryPoint]Gate, error) {
	if len(p.EntryPoints) != len(RequiredEntryPoints) {
		return nil, errors.New("all seven Supabase write entry points must be enrolled exactly once")
	}
	for _, entry := range RequiredEntryPoints {
		if p.EntryPoints[entry] == nil {
			return nil, fmt.Errorf("required %s fence target is missing", entry)
		}
	}
	return p.EntryPoints, nil
}

func (p *Provider) compensateEngage(ctx context.Context, tracked trackedFence, targets map[EntryPoint]Gate, blocked []Gate, failedEntry EntryPoint, cause error) error {
	var compensationErr error
	for index := len(blocked) - 1; index >= 0; index-- {
		compensationErr = errors.Join(compensationErr, blocked[index].Unblock(context.WithoutCancel(ctx), tracked.handle.Target))
	}
	if compensationErr == nil {
		if p.State != nil {
			_ = p.State.Delete(context.WithoutCancel(ctx), tracked.handle.ID)
			_ = p.State.AppendAudit(context.WithoutCancel(ctx), AuditEvent{HandleID: tracked.handle.ID, Target: tracked.handle.Target, Action: "engage-compensated", State: stateEngaging, Error: cause.Error(), At: p.now()})
		}
		return cause
	}
	// Compensation could not prove every path reopened. Reassert all seven
	// gates and durably record fail-closed state for operator recovery.
	var reblockErr error
	for _, entry := range RequiredEntryPoints {
		reblockErr = errors.Join(reblockErr, targets[entry].Block(context.WithoutCancel(ctx), tracked.handle.Target))
	}
	tracked.state = stateReleaseFailed
	p.mu.Lock()
	if p.handles == nil {
		p.handles = map[string]trackedFence{}
	}
	p.handles[tracked.handle.ID] = tracked
	p.mu.Unlock()
	failure := errors.Join(cause, compensationErr, reblockErr)
	_ = p.save(context.WithoutCancel(ctx), tracked, "engage-compensation-failed", failure)
	return &ReleaseError{EntryPoint: failedEntry, Cause: failure, Runbook: p.releaseRunbook(targets, tracked.handle)}
}

func (p *Provider) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}

func randomID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
