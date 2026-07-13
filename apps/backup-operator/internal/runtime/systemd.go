package runtime

import (
	"context"
	"errors"
	"fmt"
)

type UnitController interface {
	StopUnit(context.Context, string) error
	StartUnit(context.Context, string) error
	RestartUnit(context.Context, string) error
}

// Systemd only operates units enrolled at construction time. Callers cannot
// turn recovery task input into an arbitrary systemd unit name.
type Systemd struct {
	controller UnitController
	units      map[string]struct{}
}

func NewSystemd(controller UnitController, allowedUnits ...string) (*Systemd, error) {
	if controller == nil || len(allowedUnits) == 0 {
		return nil, errors.New("systemd controller and enrolled units are required")
	}
	units := make(map[string]struct{}, len(allowedUnits))
	for _, unit := range allowedUnits {
		if unit == "" || unit[0] == '-' {
			return nil, fmt.Errorf("invalid systemd unit %q", unit)
		}
		units[unit] = struct{}{}
	}
	return &Systemd{controller: controller, units: units}, nil
}

func (s *Systemd) Stop(ctx context.Context, unit string) error {
	if err := s.allowed(unit); err != nil {
		return err
	}
	return s.controller.StopUnit(ctx, unit)
}

func (s *Systemd) Start(ctx context.Context, unit string) error {
	if err := s.allowed(unit); err != nil {
		return err
	}
	return s.controller.StartUnit(ctx, unit)
}

func (s *Systemd) Restart(ctx context.Context, unit string) error {
	if err := s.allowed(unit); err != nil {
		return err
	}
	return s.controller.RestartUnit(ctx, unit)
}

func (s *Systemd) allowed(unit string) error {
	if _, ok := s.units[unit]; !ok {
		return fmt.Errorf("systemd unit %q is not enrolled", unit)
	}
	return nil
}
