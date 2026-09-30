package fleetjwt

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

// KubernetesEnvironmentReader executes a fixed, read-only printenv script. The
// command never accepts shell text from Studio or returns unrelated variables.
func KubernetesEnvironmentReader(config *rest.Config) func(context.Context, string, string, string, []string) (map[string]string, error) {
	return func(ctx context.Context, namespace, pod, container string, keys []string) (map[string]string, error) {
		if config == nil || namespace == "" || pod == "" || container == "" || len(keys) == 0 {
			return nil, errors.New("complete pod environment identity is required")
		}
		for _, key := range keys {
			allowed := false
			for _, serviceKeys := range jwtEnvironmentKeys {
				for _, candidate := range serviceKeys {
					if candidate == key {
						allowed = true
					}
				}
			}
			if !allowed {
				return nil, errors.New("environment key is not a JWT observation field")
			}
		}
		endpoint, err := url.Parse(config.Host)
		if err != nil {
			return nil, err
		}
		endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/api/v1/namespaces/" + url.PathEscape(namespace) + "/pods/" + url.PathEscape(pod) + "/exec"
		query := url.Values{"container": {container}, "stdout": {"true"}, "stderr": {"true"}, "stdin": {"false"}, "tty": {"false"}}
		script := `for name in "$@"; do value=$(printenv "$name") || continue; printf '%s=%s\000' "$name" "$value"; done`
		for _, argument := range append([]string{"/bin/sh", "-c", script, "fleet-jwt-observer"}, keys...) {
			query.Add("command", argument)
		}
		endpoint.RawQuery = query.Encode()
		executor, err := remotecommand.NewSPDYExecutor(config, http.MethodPost, endpoint)
		if err != nil {
			return nil, err
		}
		var stdout bytes.Buffer
		if err = executor.StreamWithContext(ctx, remotecommand.StreamOptions{Stdout: &boundedJWTOutput{Buffer: &stdout}, Stderr: io.Discard}); err != nil {
			return nil, errors.New("pod JWT environment read failed")
		}
		values := make(map[string]string)
		for _, record := range bytes.Split(stdout.Bytes(), []byte{0}) {
			if len(record) == 0 {
				continue
			}
			key, value, ok := strings.Cut(string(record), "=")
			if !ok {
				return nil, errors.New("invalid pod JWT environment output")
			}
			permitted := false
			for _, candidate := range keys {
				if key == candidate {
					permitted = true
				}
			}
			if !permitted {
				return nil, errors.New("unexpected pod JWT environment output")
			}
			if _, duplicate := values[key]; duplicate {
				return nil, errors.New("duplicate pod JWT environment output")
			}
			values[key] = value
		}
		return values, nil
	}
}

type boundedJWTOutput struct{ Buffer *bytes.Buffer }

func (w *boundedJWTOutput) Write(p []byte) (int, error) {
	if w.Buffer.Len()+len(p) > 32768 {
		return 0, errors.New("pod JWT environment output exceeds its limit")
	}
	return w.Buffer.Write(p)
}
