package repository

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// SecretRef is an opaque reference resolved by the runtime security boundary.
// Repository providers never persist or log credential material.
type SecretRef struct{ ID, Revision string }

type Identity struct{ Fingerprint, Revision string }
type Capacity struct {
	TotalBytes, UsedBytes, AvailableBytes int64
	ObservedAt                            time.Time
}
type AccessMode string

const (
	AccessReadOnly  AccessMode = "read-only"
	AccessReadWrite AccessMode = "read-write"
)

type AccessRequest struct {
	Config Config
	Secret SecretRef
	Mode   AccessMode
}
type RestoreAccess struct {
	Identity Identity
	ReadOnly bool
	Handle   string
}

type Backend interface {
	Revision(context.Context, Config) (string, error)
	CheckAccess(context.Context, AccessRequest) error
	Capacity(context.Context, AccessRequest) (Capacity, error)
	OpenRestore(context.Context, AccessRequest) (string, error)
}

type Provider struct {
	Backend Backend
	Now     func() time.Time
}

func (p Provider) Observe(ctx context.Context, config Config) (Identity, error) {
	if p.Backend == nil {
		return Identity{}, errors.New("repository backend is required")
	}
	fingerprint, err := Fingerprint(config)
	if err != nil {
		return Identity{}, err
	}
	revision, err := p.Backend.Revision(ctx, config)
	if err != nil {
		return Identity{}, fmt.Errorf("observe repository revision: %w", err)
	}
	if revision == "" {
		return Identity{}, errors.New("repository revision is empty")
	}
	return Identity{Fingerprint: fingerprint, Revision: revision}, nil
}

func (p Provider) CheckAccess(ctx context.Context, config Config, secret SecretRef, mode AccessMode) error {
	if p.Backend == nil {
		return errors.New("repository backend is required")
	}
	if err := validateAccess(secret, mode); err != nil {
		return err
	}
	if err := p.Backend.CheckAccess(ctx, AccessRequest{Config: config, Secret: secret, Mode: mode}); err != nil {
		return fmt.Errorf("repository %s access: %w", mode, err)
	}
	return nil
}

func (p Provider) Capacity(ctx context.Context, config Config, secret SecretRef) (Capacity, error) {
	if p.Backend == nil {
		return Capacity{}, errors.New("repository backend is required")
	}
	if err := validateAccess(secret, AccessReadOnly); err != nil {
		return Capacity{}, err
	}
	capacity, err := p.Backend.Capacity(ctx, AccessRequest{Config: config, Secret: secret, Mode: AccessReadOnly})
	if err != nil {
		return Capacity{}, fmt.Errorf("repository capacity: %w", err)
	}
	if capacity.TotalBytes < 0 || capacity.UsedBytes < 0 || capacity.AvailableBytes < 0 || capacity.UsedBytes+capacity.AvailableBytes > capacity.TotalBytes {
		return Capacity{}, errors.New("repository returned invalid capacity")
	}
	if capacity.ObservedAt.IsZero() {
		now := time.Now
		if p.Now != nil {
			now = p.Now
		}
		capacity.ObservedAt = now().UTC()
	}
	return capacity, nil
}

func (p Provider) PrepareRestore(ctx context.Context, config Config, secret SecretRef, expected Identity) (RestoreAccess, error) {
	actual, err := p.Observe(ctx, config)
	if err != nil {
		return RestoreAccess{}, err
	}
	if err := ReconcileJobIdentity(expected, actual); err != nil {
		return RestoreAccess{}, err
	}
	if err := p.CheckAccess(ctx, config, secret, AccessReadOnly); err != nil {
		return RestoreAccess{}, err
	}
	handle, err := p.Backend.OpenRestore(ctx, AccessRequest{Config: config, Secret: secret, Mode: AccessReadOnly})
	if err != nil {
		return RestoreAccess{}, fmt.Errorf("open read-only repository restore access: %w", err)
	}
	if handle == "" {
		return RestoreAccess{}, errors.New("repository returned empty restore handle")
	}
	return RestoreAccess{Identity: actual, ReadOnly: true, Handle: handle}, nil
}

func ReconcileJobIdentity(expected, actual Identity) error {
	if expected.Fingerprint == "" || expected.Revision == "" {
		return errors.New("job repository identity is incomplete")
	}
	if expected.Fingerprint != actual.Fingerprint {
		return errors.New("repository fingerprint differs from job plan")
	}
	if expected.Revision != actual.Revision {
		return errors.New("repository revision differs from job plan")
	}
	return nil
}

func validateAccess(secret SecretRef, mode AccessMode) error {
	if secret.ID == "" || secret.Revision == "" {
		return errors.New("opaque repository Secret reference is required")
	}
	if mode != AccessReadOnly && mode != AccessReadWrite {
		return errors.New("invalid repository access mode")
	}
	return nil
}
