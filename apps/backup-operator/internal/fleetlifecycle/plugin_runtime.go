package fleetlifecycle

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
)

const pluginOutputLimit = 1 << 20

type boundedBuffer struct {
	buffer   bytes.Buffer
	limit    int
	exceeded bool
}

func (b *boundedBuffer) Write(value []byte) (int, error) {
	originalLength := len(value)
	remaining := b.limit - b.buffer.Len()
	if remaining <= 0 {
		b.exceeded = true
		return originalLength, nil
	}
	if len(value) > remaining {
		value = value[:remaining]
		b.exceeded = true
	}
	_, _ = b.buffer.Write(value)
	return originalLength, nil
}

// PluginRuntime invokes one operator-configured executable without a shell.
// Phase and action are selected by this package; parameters are bounded by
// Document.Validate and are passed only as JSON on stdin.
type PluginRuntime struct{ Executable string }

type pluginRequest struct {
	Schema     string          `json:"schema"`
	Phase      string          `json:"phase"`
	Action     Action          `json:"action"`
	Parameters Parameters      `json:"parameters"`
	Before     json.RawMessage `json:"before,omitempty"`
}
type pluginResponse struct {
	Observed     json.RawMessage `json:"observed,omitempty"`
	Verification []string        `json:"verification,omitempty"`
}

func (p PluginRuntime) invoke(ctx context.Context, phase string, action Action, parameters Parameters, before json.RawMessage) (pluginResponse, error) {
	if p.Executable == "" {
		return pluginResponse{}, errors.New("lifecycle plugin executable is required")
	}
	request := pluginRequest{Schema: "supabase.fleet.lifecycle.plugin.v1", Phase: phase, Action: action, Parameters: parameters, Before: before}
	stdin, err := json.Marshal(request)
	if err != nil {
		return pluginResponse{}, err
	}
	command := exec.CommandContext(ctx, p.Executable, "--protocol", "supabase.fleet.lifecycle.plugin.v1", "--phase", phase, "--action", string(action))
	command.Stdin = bytes.NewReader(stdin)
	stdout := boundedBuffer{limit: pluginOutputLimit}
	stderr := boundedBuffer{limit: pluginOutputLimit}
	command.Stdout = &stdout
	command.Stderr = &stderr
	runErr := command.Run()
	if stdout.exceeded {
		return pluginResponse{}, errors.New("lifecycle plugin response exceeds 1 MiB")
	}
	if runErr != nil {
		return pluginResponse{}, fmt.Errorf("lifecycle plugin %s failed: %w", phase, runErr)
	}
	return decodePluginResponse(&stdout.buffer)
}

func decodePluginResponse(reader io.Reader) (pluginResponse, error) {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	var response pluginResponse
	if err := decoder.Decode(&response); err != nil {
		return pluginResponse{}, fmt.Errorf("decode lifecycle plugin response: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return pluginResponse{}, errors.New("lifecycle plugin response must contain one JSON value")
	}
	return response, nil
}

func (p PluginRuntime) Observe(ctx context.Context, a Action, v Parameters) (any, error) {
	response, err := p.invoke(ctx, "observe", a, v, nil)
	if err != nil {
		return nil, err
	}
	if len(response.Observed) == 0 || !json.Valid(response.Observed) {
		return nil, errors.New("lifecycle plugin observation is invalid")
	}
	var value any
	if json.Unmarshal(response.Observed, &value) != nil {
		return nil, errors.New("lifecycle plugin observation is invalid")
	}
	return value, nil
}
func (p PluginRuntime) Apply(ctx context.Context, a Action, v Parameters) error {
	_, err := p.invoke(ctx, "apply", a, v, nil)
	return err
}
func (p PluginRuntime) Verify(ctx context.Context, a Action, v Parameters) ([]string, error) {
	response, err := p.invoke(ctx, "verify", a, v, nil)
	return response.Verification, err
}
func (p PluginRuntime) Rollback(ctx context.Context, a Action, v Parameters, before json.RawMessage) error {
	_, err := p.invoke(ctx, "rollback", a, v, before)
	return err
}

func ParseActions(values []string) ([]Action, error) {
	result := make([]Action, 0, len(values))
	seen := map[Action]struct{}{}
	for _, value := range values {
		action := Action(value)
		if _, ok := knownActions[action]; !ok {
			return nil, fmt.Errorf("unsupported lifecycle capability %q", value)
		}
		if _, ok := seen[action]; ok {
			return nil, fmt.Errorf("duplicate lifecycle capability %q", value)
		}
		seen[action] = struct{}{}
		result = append(result, action)
	}
	if len(result) == 0 {
		return nil, errors.New("at least one lifecycle capability is required")
	}
	return result, nil
}
