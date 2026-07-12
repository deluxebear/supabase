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

type DatabaseFence interface {
	DrainWriters(context.Context) error
	ResolvePreparedTransactions(context.Context) error
	ActiveWriters(context.Context) (int, error)
	PreparedTransactions(context.Context) (int, error)
	Healthy(context.Context) error
}

type Provider struct {
	ProviderID   string
	DataPlane    Gate
	Poolers      Gate
	DirectLogins Gate
	Database     DatabaseFence
	Topology     contracts.TopologyProvider
	TTL          time.Duration
	Now          func() time.Time

	mu      sync.Mutex
	handles map[string]contracts.FenceHandle
}

func (p *Provider) ID() string { return p.ProviderID }

func (p *Provider) Engage(ctx context.Context, target contracts.TargetRef, topology contracts.TopologySnapshot) (contracts.FenceHandle, error) {
	now := p.now()
	if p.ProviderID == "" || p.DataPlane == nil || p.Poolers == nil || p.DirectLogins == nil || p.Database == nil || p.Topology == nil || p.TTL <= 0 {
		return contracts.FenceHandle{}, errors.New("write fence provider is incomplete")
	}
	if err := topology.ValidateForDestructive(now); err != nil {
		return contracts.FenceHandle{}, err
	}
	blocked := make([]Gate, 0, 3)
	rollback := func() {
		for i := len(blocked) - 1; i >= 0; i-- {
			_ = blocked[i].Unblock(context.WithoutCancel(ctx), target)
		}
	}
	for _, gate := range []Gate{p.DataPlane, p.Poolers, p.DirectLogins} {
		if err := gate.Block(ctx, target); err != nil {
			rollback()
			return contracts.FenceHandle{}, fmt.Errorf("block traffic gate: %w", err)
		}
		blocked = append(blocked, gate)
	}
	if err := p.Database.DrainWriters(ctx); err != nil {
		rollback()
		return contracts.FenceHandle{}, fmt.Errorf("drain writers: %w", err)
	}
	if err := p.Database.ResolvePreparedTransactions(ctx); err != nil {
		rollback()
		return contracts.FenceHandle{}, fmt.Errorf("resolve prepared transactions: %w", err)
	}
	id, err := randomID()
	if err != nil {
		rollback()
		return contracts.FenceHandle{}, err
	}
	handle := contracts.FenceHandle{ID: id, Target: target, Expires: now.Add(p.TTL)}
	p.mu.Lock()
	if p.handles == nil {
		p.handles = make(map[string]contracts.FenceHandle)
	}
	p.handles[id] = handle
	p.mu.Unlock()
	return handle, nil
}

func (p *Provider) Verify(ctx context.Context, handle contracts.FenceHandle) (contracts.FenceEvidence, error) {
	if !p.known(handle) {
		return contracts.FenceEvidence{}, errors.New("unknown write fence handle")
	}
	now := p.now()
	dataPlane, err := p.DataPlane.Blocked(ctx, handle.Target)
	if err != nil {
		return contracts.FenceEvidence{}, err
	}
	poolers, err := p.Poolers.Blocked(ctx, handle.Target)
	if err != nil {
		return contracts.FenceEvidence{}, err
	}
	direct, err := p.DirectLogins.Blocked(ctx, handle.Target)
	if err != nil {
		return contracts.FenceEvidence{}, err
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
	evidence := contracts.FenceEvidence{
		Evidence: contracts.Evidence{
			ProviderID: p.ProviderID, ObservationID: handle.ID, ObservedAt: now,
			ValidUntil: minTime(handle.Expires, now.Add(30*time.Second)),
			Facts:      map[string]string{"topology_observation": snapshot.Evidence.ObservationID},
		},
		DataPlaneBlocked: dataPlane, PoolersBlocked: poolers, DirectLoginBlocked: direct,
		ActiveWriters: writers, PreparedTransactions: prepared, AlternatePrimaries: max(0, primaries-1),
		ControlChannelHealthy: controlHealthy,
	}
	if err := evidence.Validate(now); err != nil {
		return evidence, err
	}
	return evidence, nil
}

func (p *Provider) Release(ctx context.Context, handle contracts.FenceHandle) (contracts.Evidence, error) {
	if !p.known(handle) {
		return contracts.Evidence{}, errors.New("unknown write fence handle")
	}
	for _, gate := range []Gate{p.DirectLogins, p.Poolers, p.DataPlane} {
		if err := gate.Unblock(ctx, handle.Target); err != nil {
			return contracts.Evidence{}, fmt.Errorf("release traffic gate: %w", err)
		}
	}
	p.mu.Lock()
	delete(p.handles, handle.ID)
	p.mu.Unlock()
	now := p.now()
	return contracts.Evidence{ProviderID: p.ProviderID, ObservationID: handle.ID + "-released", ObservedAt: now, ValidUntil: now.Add(30 * time.Second)}, nil
}

func (p *Provider) known(handle contracts.FenceHandle) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	known, ok := p.handles[handle.ID]
	return ok && known.Target == handle.Target && known.Expires.Equal(handle.Expires)
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
