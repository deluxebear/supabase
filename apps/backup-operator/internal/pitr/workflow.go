package pitr

import (
	"context"
	"errors"
	"fmt"
)

type Phase string

const (
	PhaseDisabled    Phase = "disabled"
	PhaseValidated   Phase = "validated"
	PhaseConfigured  Phase = "configured"
	PhaseArchiveOn   Phase = "archive-on"
	PhaseRestarted   Phase = "restarted"
	PhaseStanzaReady Phase = "stanza-ready"
	PhaseChecked     Phase = "checked"
	PhaseWALArchived Phase = "wal-archived"
	PhaseEnabled     Phase = "enabled"
)

type State struct {
	TargetID   string
	Generation int64
	Phase      Phase
}

type StateStore interface {
	Load(context.Context, string) (State, error)
	Save(context.Context, State) error
}

type Runtime interface {
	Validate(context.Context) error
	ApplyConfig(context.Context) error
	RollbackConfig(context.Context) error
	SetArchiving(context.Context, bool) error
	Restart(context.Context) error
	StanzaCreate(context.Context) error
	Check(context.Context) error
	ForceWALSwitch(context.Context) error
	FirstFullBackup(context.Context, string) error
}

type Workflow struct {
	Store   StateStore
	Runtime Runtime
}

func (w Workflow) Enable(ctx context.Context, targetID string, generation int64) (err error) {
	if w.Store == nil || w.Runtime == nil || targetID == "" || generation < 1 {
		return errors.New("PITR workflow store, runtime, target, and generation are required")
	}
	state, err := w.Store.Load(ctx, targetID)
	if err != nil {
		return err
	}
	if state.Generation > generation {
		return errors.New("cannot apply a stale PITR generation")
	}
	if state.Generation != generation {
		state = State{TargetID: targetID, Generation: generation, Phase: PhaseDisabled}
	}
	if state.Phase == PhaseEnabled {
		return nil
	}
	configured := phaseAtLeast(state.Phase, PhaseConfigured)
	archiveOn := phaseAtLeast(state.Phase, PhaseArchiveOn)
	defer func() {
		if err == nil || state.Phase == PhaseEnabled {
			return
		}
		var compensation error
		if archiveOn {
			compensation = errors.Join(compensation, w.Runtime.SetArchiving(ctx, false))
		}
		if configured {
			compensation = errors.Join(compensation, w.Runtime.RollbackConfig(ctx))
		}
		if archiveOn || configured {
			compensation = errors.Join(compensation, w.Runtime.Restart(ctx))
		}
		state.Phase = PhaseDisabled
		compensation = errors.Join(compensation, w.Store.Save(ctx, state))
		err = errors.Join(err, compensation)
	}()
	steps := []struct {
		phase Phase
		run   func() error
	}{
		{PhaseValidated, func() error { return w.Runtime.Validate(ctx) }},
		{PhaseConfigured, func() error { return w.Runtime.ApplyConfig(ctx) }},
		{PhaseArchiveOn, func() error { return w.Runtime.SetArchiving(ctx, true) }},
		{PhaseRestarted, func() error { return w.Runtime.Restart(ctx) }},
		{PhaseStanzaReady, func() error { return w.Runtime.StanzaCreate(ctx) }},
		{PhaseChecked, func() error { return w.Runtime.Check(ctx) }},
		{PhaseWALArchived, func() error { return w.Runtime.ForceWALSwitch(ctx) }},
		{PhaseEnabled, func() error {
			return w.Runtime.FirstFullBackup(ctx, fmt.Sprintf("pitr-enable/%s/%d", targetID, generation))
		}},
	}
	for _, step := range steps {
		if phaseAtLeast(state.Phase, step.phase) {
			continue
		}
		if err = step.run(); err != nil {
			return fmt.Errorf("PITR enable phase %s: %w", step.phase, err)
		}
		if step.phase == PhaseConfigured {
			configured = true
		}
		if step.phase == PhaseArchiveOn {
			archiveOn = true
		}
		state.Phase = step.phase
		if err = w.Store.Save(ctx, state); err != nil {
			return err
		}
	}
	return nil
}

func (w Workflow) Disable(ctx context.Context, targetID string, generation int64) error {
	if w.Store == nil || w.Runtime == nil || targetID == "" || generation < 1 {
		return errors.New("PITR workflow store, runtime, target, and generation are required")
	}
	state, err := w.Store.Load(ctx, targetID)
	if err != nil {
		return err
	}
	if state.Generation > generation {
		return errors.New("cannot disable a newer PITR generation")
	}
	if state.Phase == PhaseDisabled && state.Generation == generation {
		return nil
	}
	// Disabling stops future WAL archival. Repository data is deliberately untouched.
	if err := w.Runtime.SetArchiving(ctx, false); err != nil {
		return err
	}
	if err := w.Runtime.Restart(ctx); err != nil {
		return err
	}
	return w.Store.Save(ctx, State{TargetID: targetID, Generation: generation, Phase: PhaseDisabled})
}

var phaseOrder = map[Phase]int{PhaseDisabled: 0, PhaseValidated: 1, PhaseConfigured: 2, PhaseArchiveOn: 3, PhaseRestarted: 4, PhaseStanzaReady: 5, PhaseChecked: 6, PhaseWALArchived: 7, PhaseEnabled: 8}

func phaseAtLeast(current, expected Phase) bool { return phaseOrder[current] >= phaseOrder[expected] }
