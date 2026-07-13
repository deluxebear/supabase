package writefence

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
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
	Runner          CommandRunner
	AllowedBinaries []string
	AllowedCommands []Command
	Block           Command
	Status          Command
	Unblock         Command
}

func (g CommandGate) BlockTraffic(ctx context.Context, _ contracts.TargetRef) error {
	return g.run(ctx, g.Block)
}

func (g CommandGate) Blocked(ctx context.Context, _ contracts.TargetRef) (bool, error) {
	output, err := g.output(ctx, g.Status)
	if err != nil {
		return false, err
	}
	switch strings.TrimSpace(string(output)) {
	case "blocked":
		return true, nil
	case "open":
		return false, nil
	default:
		return false, errors.New("command gate returned an ambiguous status")
	}
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
	if !filepath.IsAbs(command.Binary) || filepath.Clean(command.Binary) != command.Binary || !slices.Contains(g.AllowedBinaries, command.Binary) {
		return nil, errors.New("command gate binary is not enrolled")
	}
	info, err := os.Stat(command.Binary)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o022 != 0 {
		return nil, errors.New("command gate binary must be a non-group/world-writable regular file")
	}
	allowed := false
	for _, enrolled := range g.AllowedCommands {
		if command.Binary == enrolled.Binary && slices.Equal(command.Args, enrolled.Args) {
			allowed = true
			break
		}
	}
	if !allowed {
		return nil, errors.New("command gate argv is not enrolled")
	}
	return g.Runner.Run(ctx, command.Binary, command.Args...)
}

func (g commandGateAdapter) ReleaseRunbook() []string {
	return []string{
		fmt.Sprintf("%s %s", g.gate.Block.Binary, strings.Join(g.gate.Block.Args, " ")),
		fmt.Sprintf("%s %s", g.gate.Status.Binary, strings.Join(g.gate.Status.Args, " ")),
	}
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
