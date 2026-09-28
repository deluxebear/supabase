// fleet-lifecycle-compose is the reference Compose lifecycle plugin. The Fleet
// Agent runs it once per phase with the typed request on stdin:
//
//	fleet-lifecycle-compose --protocol supabase.fleet.lifecycle.plugin.v1 --phase observe --action runtime.restart
//
// Operator configuration comes only from the environment:
//
//	FLEET_LIFECYCLE_COMPOSE_PROJECT      Compose project name
//	FLEET_LIFECYCLE_SERVICES             comma-separated allowlisted services
//	FLEET_LIFECYCLE_DOCKER_ENDPOINT      http:// URL of fleet-docker-proxy (lifecycle policy)
//	FLEET_LIFECYCLE_COMPOSE_BINARY       Compose CLI (default /usr/local/bin/docker-compose)
//	FLEET_LIFECYCLE_PROJECT_DIRECTORY    Compose project directory, at its host path
//	FLEET_LIFECYCLE_COMPOSE_FILES        comma-separated Compose files
//	FLEET_LIFECYCLE_ENV_FILES            comma-separated env files
//	FLEET_LIFECYCLE_VERIFY_TIMEOUT       health wait (default 2m)
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/composelifecycle"
)

const maxRequestBytes = 1 << 20

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Stdin, os.Stdout, os.Getenv, nil); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, stdin io.Reader, stdout io.Writer, getenv func(string) string, plugin *composelifecycle.Plugin) error {
	flags := flag.NewFlagSet("fleet-lifecycle-compose", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	protocol := flags.String("protocol", "", "plugin protocol")
	phase := flags.String("phase", "", "lifecycle phase")
	action := flags.String("action", "", "lifecycle action")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *protocol != composelifecycle.Protocol {
		return fmt.Errorf("unsupported plugin protocol %q", *protocol)
	}
	decoder := json.NewDecoder(io.LimitReader(stdin, maxRequestBytes))
	decoder.DisallowUnknownFields()
	var request composelifecycle.Request
	if err := decoder.Decode(&request); err != nil {
		return fmt.Errorf("decode plugin request: %w", err)
	}
	if request.Phase != *phase || string(request.Action) != *action {
		return errors.New("plugin request does not match the phase and action arguments")
	}
	if plugin == nil {
		configured, err := pluginFromEnvironment(getenv)
		if err != nil {
			return err
		}
		plugin = &configured
	}
	response, err := plugin.Handle(ctx, request)
	if err != nil {
		return err
	}
	return json.NewEncoder(stdout).Encode(response)
}

func pluginFromEnvironment(getenv func(string) string) (composelifecycle.Plugin, error) {
	project := strings.TrimSpace(getenv("FLEET_LIFECYCLE_COMPOSE_PROJECT"))
	endpoint := strings.TrimRight(strings.TrimSpace(getenv("FLEET_LIFECYCLE_DOCKER_ENDPOINT")), "/")
	services := splitList(getenv("FLEET_LIFECYCLE_SERVICES"))
	if project == "" || !strings.HasPrefix(endpoint, "http://") || len(services) == 0 {
		return composelifecycle.Plugin{}, errors.New("Compose project, http:// Docker proxy endpoint, and allowlisted services are required")
	}
	for _, service := range services {
		if !validService(service) {
			return composelifecycle.Plugin{}, fmt.Errorf("service %q is not a valid Compose service name", service)
		}
	}
	binary := strings.TrimSpace(getenv("FLEET_LIFECYCLE_COMPOSE_BINARY"))
	if binary == "" {
		binary = "/usr/local/bin/docker-compose"
	}
	timeout := 2 * time.Minute
	if raw := strings.TrimSpace(getenv("FLEET_LIFECYCLE_VERIFY_TIMEOUT")); raw != "" {
		parsed, err := time.ParseDuration(raw)
		if err != nil || parsed <= 0 || parsed > 10*time.Minute {
			return composelifecycle.Plugin{}, errors.New("FLEET_LIFECYCLE_VERIFY_TIMEOUT must be a duration up to 10m")
		}
		timeout = parsed
	}
	allowed := map[string]struct{}{}
	for _, service := range services {
		allowed[service] = struct{}{}
	}
	return composelifecycle.Plugin{
		Services: allowed,
		Docker:   composelifecycle.HTTPDocker{Endpoint: endpoint},
		Compose: composelifecycle.ComposeCLI{
			Binary: binary, Project: project,
			ProjectDirectory: strings.TrimSpace(getenv("FLEET_LIFECYCLE_PROJECT_DIRECTORY")),
			Files:            splitList(getenv("FLEET_LIFECYCLE_COMPOSE_FILES")),
			EnvFiles:         splitList(getenv("FLEET_LIFECYCLE_ENV_FILES")),
			DockerHost:       "tcp://" + strings.TrimPrefix(endpoint, "http://"),
		},
		VerifyTimeout: timeout,
	}, nil
}

func validService(value string) bool {
	if value == "" || len(value) > 63 {
		return false
	}
	for index, character := range value {
		isLetter := character >= 'a' && character <= 'z'
		isDigit := character >= '0' && character <= '9'
		if !(isLetter || (index > 0 && (isDigit || character == '-'))) {
			return false
		}
	}
	return true
}

func splitList(value string) []string {
	result := make([]string, 0)
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result = append(result, item)
		}
	}
	return result
}
