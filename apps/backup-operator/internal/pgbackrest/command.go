package pgbackrest

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const DefaultBinary = "/usr/lib/pgbackrest/bin/pgbackrest.real"

type Command struct {
	Path string
	Args []string
}

type Output struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int
}

type Runner interface {
	Run(context.Context, Command) (Output, error)
}

type Builder struct{ Binary, ConfigPath string }

func (b Builder) command(stanza, operation string, options ...string) (Command, error) {
	if !tokenPattern.MatchString(stanza) {
		return Command{}, errors.New("invalid stanza")
	}
	binary := b.Binary
	if binary == "" {
		binary = DefaultBinary
	}
	if !cleanAbsolute(binary) {
		return Command{}, errors.New("pgBackRest binary must be an absolute clean path")
	}
	args := make([]string, 0, len(options)+3)
	if b.ConfigPath != "" {
		if !cleanAbsolute(b.ConfigPath) {
			return Command{}, errors.New("invalid config path")
		}
		args = append(args, "--config="+b.ConfigPath)
	}
	args = append(args, "--stanza="+stanza)
	args = append(args, options...)
	args = append(args, operation)
	return Command{Path: binary, Args: args}, nil
}

func (b Builder) Info(stanza string) (Command, error) {
	return b.command(stanza, "info", "--output=json")
}
func (b Builder) Check(stanza string) (Command, error) { return b.command(stanza, "check") }
func (b Builder) StanzaCreate(stanza string) (Command, error) {
	return b.command(stanza, "stanza-create")
}
func (b Builder) Expire(stanza string) (Command, error) { return b.command(stanza, "expire") }

func (b Builder) Backup(stanza, backupType string) (Command, error) {
	if backupType != "full" && backupType != "diff" && backupType != "incr" {
		return Command{}, errors.New("invalid backup type")
	}
	return b.command(stanza, "backup", "--type="+backupType)
}

type RestoreOptions struct {
	PGData       string
	Set          string
	TargetTime   *time.Time
	TargetAction string
	Delta        bool
}

func (b Builder) Restore(stanza string, options RestoreOptions) (Command, error) {
	if !cleanAbsolute(options.PGData) {
		return Command{}, errors.New("restore pgdata must be an absolute clean path")
	}
	args := []string{"--pg1-path=" + options.PGData}
	if options.Set != "" {
		if !regexp.MustCompile(`^[0-9]{8}-[0-9]{6}[FDI]$`).MatchString(options.Set) {
			return Command{}, errors.New("invalid backup set label")
		}
		args = append(args, "--set="+options.Set)
	}
	if options.TargetTime != nil {
		args = append(args, "--type=time", "--target="+options.TargetTime.UTC().Format("2006-01-02 15:04:05.999999-07"))
	}
	if options.TargetAction != "" {
		if options.TargetAction != "pause" && options.TargetAction != "promote" && options.TargetAction != "shutdown" {
			return Command{}, errors.New("invalid recovery target action")
		}
		args = append(args, "--target-action="+options.TargetAction)
	}
	if options.Delta {
		args = append(args, "--delta")
	}
	return b.command(stanza, "restore", args...)
}

func cleanAbsolute(path string) bool {
	return filepath.IsAbs(path) && filepath.Clean(path) == path && !strings.ContainsAny(path, "\r\n\x00")
}

type ErrorKind string

const (
	ErrorConfig           ErrorKind = "config"
	ErrorRepositoryAccess ErrorKind = "repository_access"
	ErrorBackupMissing    ErrorKind = "backup_missing"
	ErrorLockConflict     ErrorKind = "lock_conflict"
	ErrorThrottled        ErrorKind = "throttled"
	ErrorCommandFailed    ErrorKind = "command_failed"
)

type CommandError struct {
	Kind      ErrorKind
	Operation string
	ExitCode  int
}

func (e *CommandError) Error() string {
	return fmt.Sprintf("pgBackRest %s failed (%s, exit %d)", e.Operation, e.Kind, e.ExitCode)
}

func ClassifyError(operation string, output Output, runErr error) error {
	if runErr == nil && output.ExitCode == 0 {
		return nil
	}
	text := strings.ToLower(string(output.Stderr))
	kind := ErrorCommandFailed
	switch {
	case strings.Contains(text, "429") || strings.Contains(text, "too many requests") || strings.Contains(text, "slowdown") || strings.Contains(text, "please reduce your request rate"):
		kind = ErrorThrottled
	case strings.Contains(text, "configuration") || strings.Contains(text, "option") && strings.Contains(text, "invalid"):
		kind = ErrorConfig
	case strings.Contains(text, "unable to load info file") || strings.Contains(text, "repository") && (strings.Contains(text, "permission") || strings.Contains(text, "access")):
		kind = ErrorRepositoryAccess
	case strings.Contains(text, "backup set") && strings.Contains(text, "not found"):
		kind = ErrorBackupMissing
	case strings.Contains(text, "lock") && (strings.Contains(text, "held") || strings.Contains(text, "timeout")):
		kind = ErrorLockConflict
	}
	return &CommandError{Kind: kind, Operation: operation, ExitCode: output.ExitCode}
}

type Client struct {
	Builder       Builder
	Runner        Runner
	RetryAttempts int
	RetryDelay    time.Duration
}

func (c Client) execute(ctx context.Context, operation string, command Command) (Output, error) {
	if c.Runner == nil {
		return Output{}, errors.New("pgBackRest runner is required")
	}
	attempts := c.RetryAttempts
	if attempts < 1 {
		attempts = 1
	}
	for attempt := 1; attempt <= attempts; attempt++ {
		output, err := c.Runner.Run(ctx, command)
		classified := ClassifyError(operation, output, err)
		if classified == nil {
			return output, nil
		}
		var commandError *CommandError
		if !errors.As(classified, &commandError) || commandError.Kind != ErrorThrottled || attempt == attempts {
			return Output{}, classified
		}
		delay := c.RetryDelay
		if delay <= 0 {
			delay = time.Second
		}
		timer := time.NewTimer(delay * time.Duration(attempt))
		select {
		case <-ctx.Done():
			timer.Stop()
			return Output{}, ctx.Err()
		case <-timer.C:
		}
	}
	return Output{}, errors.New("pgBackRest retry loop exhausted")
}

func (c Client) RunInfo(ctx context.Context, stanza string) ([]StanzaInfo, error) {
	command, err := c.Builder.Info(stanza)
	if err != nil {
		return nil, err
	}
	out, err := c.execute(ctx, "info", command)
	if err != nil {
		return nil, err
	}
	return ParseInfo(out.Stdout)
}
func (c Client) RunCheck(ctx context.Context, stanza string) error {
	command, err := c.Builder.Check(stanza)
	if err != nil {
		return err
	}
	_, err = c.execute(ctx, "check", command)
	return err
}
func (c Client) RunStanzaCreate(ctx context.Context, stanza string) error {
	command, err := c.Builder.StanzaCreate(stanza)
	if err != nil {
		return err
	}
	_, err = c.execute(ctx, "stanza-create", command)
	return err
}
func (c Client) RunBackup(ctx context.Context, stanza, kind string) error {
	command, err := c.Builder.Backup(stanza, kind)
	if err != nil {
		return err
	}
	_, err = c.execute(ctx, "backup", command)
	return err
}
func (c Client) RunExpire(ctx context.Context, stanza string) error {
	command, err := c.Builder.Expire(stanza)
	if err != nil {
		return err
	}
	_, err = c.execute(ctx, "expire", command)
	return err
}
func (c Client) RunRestore(ctx context.Context, stanza string, options RestoreOptions) error {
	command, err := c.Builder.Restore(stanza, options)
	if err != nil {
		return err
	}
	_, err = c.execute(ctx, "restore", command)
	return err
}

func parseInt64(value string) (int64, error) { return strconv.ParseInt(value, 10, 64) }
