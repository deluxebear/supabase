package writefence

import (
	"context"
	"errors"
	"strings"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

type CommandRunner interface {
	Run(context.Context, string, ...string) ([]byte, error)
}

type Command struct {
	Binary string
	Args   []string
}

// CommandGate lets deployment adapters use systemd, Docker Compose, or
// Kubernetes commands without invoking a shell or interpolating target data.
type CommandGate struct {
	Runner  CommandRunner
	Block   Command
	Status  Command
	Unblock Command
}

func (g CommandGate) BlockTraffic(ctx context.Context, _ contracts.TargetRef) error {
	return g.run(ctx, g.Block)
}

func (g CommandGate) Blocked(ctx context.Context, _ contracts.TargetRef) (bool, error) {
	output, err := g.output(ctx, g.Status)
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(string(output)) == "blocked", nil
}

func (g CommandGate) UnblockTraffic(ctx context.Context, _ contracts.TargetRef) error {
	return g.run(ctx, g.Unblock)
}

// Adapter converts the explicit method names to the generic Gate contract.
func (g CommandGate) AsGate() Gate { return commandGateAdapter{gate: g} }

func (g CommandGate) run(ctx context.Context, command Command) error {
	_, err := g.output(ctx, command)
	return err
}

func (g CommandGate) output(ctx context.Context, command Command) ([]byte, error) {
	if g.Runner == nil || command.Binary == "" {
		return nil, errors.New("command gate runner and binary are required")
	}
	return g.Runner.Run(ctx, command.Binary, command.Args...)
}

type commandGateAdapter struct{ gate CommandGate }

func (a commandGateAdapter) Block(ctx context.Context, target contracts.TargetRef) error {
	return a.gate.BlockTraffic(ctx, target)
}
func (a commandGateAdapter) Blocked(ctx context.Context, target contracts.TargetRef) (bool, error) {
	return a.gate.Blocked(ctx, target)
}
func (a commandGateAdapter) Unblock(ctx context.Context, target contracts.TargetRef) error {
	return a.gate.UnblockTraffic(ctx, target)
}
