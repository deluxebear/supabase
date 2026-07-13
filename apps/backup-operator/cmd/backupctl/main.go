package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/version"
)

const (
	exitOK          = 0
	exitFailure     = 1
	exitUsage       = 2
	exitAuth        = 3
	exitNotFound    = 4
	exitConflict    = 5
	exitUnavailable = 6
	exitSafety      = 7
)

var errSafetyConfirmation = errors.New("safety confirmation failed")

type client struct {
	endpoint string
	token    string
	http     *http.Client
}

type request struct {
	method         string
	path           string
	body           any
	idempotencyKey string
}

type job struct {
	ID        string `json:"id"`
	State     string `json:"state"`
	ErrorCode string `json:"errorCode,omitempty"`
}

type apiError struct {
	Status  int
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *apiError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("Operator returned HTTP %d", e.Status)
}

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }

func run(args []string, stdout, stderr io.Writer) int {
	global := flag.NewFlagSet("backupctl", flag.ContinueOnError)
	global.SetOutput(stderr)
	endpoint := global.String("endpoint", envOr("BACKUP_OPERATOR_URL", "http://127.0.0.1:8080"), "Operator API endpoint")
	token := global.String("token", os.Getenv("BACKUP_OPERATOR_TOKEN"), "service assertion (or BACKUP_OPERATOR_TOKEN)")
	timeout := global.Duration("timeout", 30*time.Second, "request timeout")
	idempotencyKey := global.String("idempotency-key", "", "stable key for mutation retries (generated when omitted)")
	showVersion := global.Bool("version", false, "print version and exit")
	if err := global.Parse(args); err != nil {
		return exitUsage
	}
	if *showVersion {
		fmt.Fprintln(stdout, version.String())
		return exitOK
	}
	remaining := global.Args()
	if len(remaining) == 0 {
		usage(stderr)
		return exitUsage
	}
	parsedURL, err := url.Parse(*endpoint)
	if err != nil || parsedURL.Scheme == "" || parsedURL.Host == "" {
		fmt.Fprintln(stderr, "--endpoint must be an absolute HTTP(S) URL")
		return exitUsage
	}
	c := client{endpoint: strings.TrimRight(*endpoint, "/"), token: *token, http: &http.Client{Timeout: *timeout}}
	command, watch, interval, err := parseCommand(remaining)
	if err != nil {
		fmt.Fprintln(stderr, err)
		if errors.Is(err, errSafetyConfirmation) {
			return exitSafety
		}
		return exitUsage
	}
	ctx := context.Background()
	if isMutation(command.method) {
		command.idempotencyKey = strings.TrimSpace(*idempotencyKey)
		if command.idempotencyKey == "" {
			command.idempotencyKey, err = newIdempotencyKey()
			if err != nil {
				fmt.Fprintln(stderr, err)
				return exitFailure
			}
		}
	}
	if watch {
		return watchJob(ctx, c, command.path, interval, stdout, stderr)
	}
	var result any
	if err := c.do(ctx, command, &result); err != nil {
		fmt.Fprintln(stderr, err)
		return exitForError(err)
	}
	if result != nil {
		encoder := json.NewEncoder(stdout)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(result); err != nil {
			fmt.Fprintln(stderr, err)
			return exitFailure
		}
	}
	return exitOK
}

func parseCommand(args []string) (request, bool, time.Duration, error) {
	if len(args) < 2 && args[0] != "capabilities" {
		return request{}, false, 0, errors.New("a command and action are required")
	}
	if args[0] == "capabilities" {
		return request{method: http.MethodGet, path: "/v1/capabilities"}, false, 0, nil
	}
	action, rest := args[1], args[2:]
	switch args[0] {
	case "cluster":
		if action == "list" {
			return request{method: http.MethodGet, path: "/v1/clusters"}, false, 0, requireNoArgs(rest)
		}
		if action == "get" {
			id, err := requiredValue(rest, "--id")
			return request{method: http.MethodGet, path: "/v1/clusters/" + url.PathEscape(id)}, false, 0, err
		}
	case "policy":
		if action == "get" {
			cluster, _, err := parseValues(rest, "cluster")
			path := "/v1/clusters/" + url.PathEscape(cluster) + "/backup-policy"
			return request{method: http.MethodGet, path: path}, false, 0, err
		}
		if action == "apply" {
			cluster, values, err := parseValues(rest, "cluster", "input")
			if err != nil {
				return request{}, false, 0, err
			}
			path := "/v1/clusters/" + url.PathEscape(cluster) + "/backup-policy"
			body, err := readPolicy(values["input"])
			return request{method: http.MethodPut, path: path, body: body}, false, 0, err
		}
	case "backup":
		if action == "run" {
			cluster, values, err := parseValues(rest, "cluster", "type")
			if err != nil {
				return request{}, false, 0, err
			}
			if values["type"] != "full" && values["type"] != "diff" && values["type"] != "incr" {
				return request{}, false, 0, errors.New("--type must be full, diff, or incr")
			}
			return request{method: http.MethodPost, path: "/v1/clusters/" + url.PathEscape(cluster) + "/backups", body: map[string]string{"type": values["type"]}}, false, 0, nil
		}
	case "job":
		id, values, err := parseValues(rest, "id")
		if err != nil {
			return request{}, false, 0, err
		}
		path := "/v1/operations/" + url.PathEscape(id)
		switch action {
		case "get":
			return request{method: http.MethodGet, path: path}, false, 0, nil
		case "watch":
			interval := time.Second
			if raw := values["interval"]; raw != "" {
				interval, err = time.ParseDuration(raw)
			}
			return request{method: http.MethodGet, path: path}, true, interval, err
		case "cancel", "retry":
			return request{method: http.MethodPost, path: path + "/" + action, body: map[string]any{}}, false, 0, nil
		}
	case "restore":
		return parseRestore(action, rest)
	case "maintenance":
		if action == "run" {
			cluster, values, err := parseValues(rest, "cluster", "kind")
			if err != nil {
				return request{}, false, 0, err
			}
			if values["kind"] != "repository-check" && values["kind"] != "expire" && values["kind"] != "restore-drill" {
				return request{}, false, 0, errors.New("--kind must be repository-check, expire, or restore-drill")
			}
			return request{method: http.MethodPost, path: "/v1/clusters/" + url.PathEscape(cluster) + "/maintenance", body: map[string]string{"kind": values["kind"]}}, false, 0, nil
		}
	case "audit":
		if action == "export" {
			_, values, err := parseValues(rest, "")
			if err != nil {
				return request{}, false, 0, err
			}
			after, limit := values["after"], values["limit"]
			if after == "" {
				after = "0"
			}
			if limit == "" {
				limit = "1000"
			}
			if _, err := strconv.ParseInt(after, 10, 64); err != nil {
				return request{}, false, 0, errors.New("--after must be an integer")
			}
			parsedLimit, err := strconv.Atoi(limit)
			if err != nil || parsedLimit < 1 || parsedLimit > 10000 {
				return request{}, false, 0, errors.New("--limit must be between 1 and 10000")
			}
			return request{method: http.MethodGet, path: "/v1/audit?after=" + url.QueryEscape(after) + "&limit=" + url.QueryEscape(limit)}, false, 0, nil
		}
	}
	return request{}, false, 0, fmt.Errorf("unsupported command %q", strings.Join(args[:2], " "))
}

func parseRestore(action string, args []string) (request, bool, time.Duration, error) {
	switch action {
	case "plan":
		cluster, values, err := parseValues(args, "cluster", "target")
		if err != nil {
			return request{}, false, 0, err
		}
		if _, err := time.Parse(time.RFC3339, values["target"]); err != nil {
			return request{}, false, 0, errors.New("--target must be RFC3339")
		}
		return request{method: http.MethodPost, path: "/v1/clusters/" + url.PathEscape(cluster) + "/restore-plans", body: map[string]string{"recoveryTarget": values["target"]}}, false, 0, nil
	case "confirm", "execute":
		cluster, values, err := parseValues(args, "cluster", "plan", "hash", "confirm-hash")
		if err != nil {
			return request{}, false, 0, err
		}
		if values["hash"] != values["confirm-hash"] {
			return request{}, false, 0, fmt.Errorf("%w: --confirm-hash must exactly match --hash", errSafetyConfirmation)
		}
		body := map[string]string{"planHash": values["hash"]}
		return request{method: http.MethodPost, path: "/v1/clusters/" + url.PathEscape(cluster) + "/restore-plans/" + url.PathEscape(values["plan"]) + "/" + action, body: body}, false, 0, nil
	case "rollback":
		cluster, values, err := parseValues(args, "cluster", "job", "hash", "confirm-hash")
		if err != nil {
			return request{}, false, 0, err
		}
		if values["hash"] != values["confirm-hash"] {
			return request{}, false, 0, fmt.Errorf("%w: --confirm-hash must exactly match --hash", errSafetyConfirmation)
		}
		return request{method: http.MethodPost, path: "/v1/clusters/" + url.PathEscape(cluster) + "/jobs/" + url.PathEscape(values["job"]) + "/rollback", body: map[string]string{"planHash": values["hash"]}}, false, 0, nil
	}
	return request{}, false, 0, fmt.Errorf("unsupported restore action %q", action)
}

func parseValues(args []string, positionalName string, required ...string) (string, map[string]string, error) {
	values := map[string]string{}
	for index := 0; index < len(args); index++ {
		if !strings.HasPrefix(args[index], "--") || index+1 >= len(args) {
			return "", nil, fmt.Errorf("invalid option %q", args[index])
		}
		values[strings.TrimPrefix(args[index], "--")] = args[index+1]
		index++
	}
	allRequired := append([]string{}, required...)
	if positionalName != "" {
		allRequired = append([]string{positionalName}, allRequired...)
	}
	for _, name := range allRequired {
		if strings.TrimSpace(values[name]) == "" {
			return "", nil, fmt.Errorf("--%s is required", name)
		}
	}
	return values[positionalName], values, nil
}

func requiredValue(args []string, name string) (string, error) {
	_, values, err := parseValues(args, strings.TrimPrefix(name, "--"))
	return values[strings.TrimPrefix(name, "--")], err
}

func requireNoArgs(args []string) error {
	if len(args) != 0 {
		return errors.New("unexpected arguments")
	}
	return nil
}

type policyInput struct {
	Enabled           bool   `json:"enabled"`
	RetentionDays     int    `json:"retentionDays"`
	FullSchedule      string `json:"fullSchedule"`
	DiffSchedule      string `json:"diffSchedule,omitempty"`
	IncrSchedule      string `json:"incrSchedule,omitempty"`
	BackupFrom        string `json:"backupFrom"`
	DesignatedStandby string `json:"designatedStandby,omitempty"`
}

func readPolicy(path string) (policyInput, error) {
	if path == "" {
		return policyInput{}, errors.New("--input is required")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return policyInput{}, err
	}
	var value policyInput
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return policyInput{}, fmt.Errorf("input must be a backup policy JSON object: %w", err)
	}
	if value.RetentionDays < 1 || value.FullSchedule == "" || (value.BackupFrom != "primary" && value.BackupFrom != "standby") || (value.BackupFrom == "standby" && value.DesignatedStandby == "") {
		return policyInput{}, errors.New("policy requires positive retentionDays, fullSchedule, and a valid backupFrom target")
	}
	return value, nil
}

func (c client) do(ctx context.Context, command request, result any) error {
	var body io.Reader
	if command.body != nil {
		payload, err := json.Marshal(command.body)
		if err != nil {
			return err
		}
		body = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, command.method, c.endpoint+command.path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if command.body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if isMutation(command.method) {
		if strings.TrimSpace(command.idempotencyKey) == "" {
			return errors.New("mutation idempotency key is required")
		}
		req.Header.Set("Idempotency-Key", command.idempotencyKey)
	}
	response, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("Operator unavailable: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		value := &apiError{Status: response.StatusCode}
		_ = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(value)
		return value
	}
	if result == nil || response.StatusCode == http.StatusNoContent {
		return nil
	}
	return json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(result)
}

func isMutation(method string) bool {
	return method == http.MethodPost || method == http.MethodPut || method == http.MethodPatch || method == http.MethodDelete
}

func newIdempotencyKey() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("generate idempotency key: %w", err)
	}
	return "backupctl-" + hex.EncodeToString(value[:]), nil
}

func watchJob(ctx context.Context, c client, path string, interval time.Duration, stdout, stderr io.Writer) int {
	if interval < 100*time.Millisecond || interval > time.Minute {
		fmt.Fprintln(stderr, "--interval must be between 100ms and 1m")
		return exitUsage
	}
	for {
		var current job
		if err := c.do(ctx, request{method: http.MethodGet, path: path}, &current); err != nil {
			fmt.Fprintln(stderr, err)
			return exitForError(err)
		}
		_ = json.NewEncoder(stdout).Encode(current)
		switch current.State {
		case "succeeded":
			return exitOK
		case "failed", "cancelled", "orphaned", "manual-intervention":
			return exitFailure
		}
		select {
		case <-ctx.Done():
			return exitFailure
		case <-time.After(interval):
		}
	}
}

func exitForError(err error) int {
	var api *apiError
	if errors.As(err, &api) {
		switch api.Status {
		case 401, 403:
			return exitAuth
		case 404:
			return exitNotFound
		case 409:
			return exitConflict
		case 502, 503, 504:
			return exitUnavailable
		}
	}
	if errors.Is(err, errSafetyConfirmation) {
		return exitSafety
	}
	if strings.Contains(err.Error(), "unavailable") {
		return exitUnavailable
	}
	return exitFailure
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func usage(writer io.Writer) {
	fmt.Fprintln(writer, "usage: backupctl [global flags] <cluster|policy|backup|job|restore|maintenance|audit> <action> [flags]")
}
