package patroni

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type HTTPAPI struct {
	BaseURL string
	Client  *http.Client
}

func (a HTTPAPI) Cluster(ctx context.Context) (Cluster, error) {
	var response struct {
		Members []struct {
			Name     string `json:"name"`
			Role     string `json:"role"`
			State    string `json:"state"`
			Timeline uint64 `json:"timeline"`
			Lag      int64  `json:"lag"`
		} `json:"members"`
	}
	if err := a.request(ctx, http.MethodGet, "/cluster", nil, &response); err != nil {
		return Cluster{}, err
	}
	cluster := Cluster{Members: make([]Member, 0, len(response.Members))}
	for _, member := range response.Members {
		cluster.Members = append(cluster.Members, Member{Name: member.Name, Role: member.Role, State: member.State, Timeline: member.Timeline, LagBytes: member.Lag})
	}
	return cluster, nil
}

func (a HTTPAPI) Config(ctx context.Context) (Config, error) {
	var response struct {
		Pause                 bool `json:"pause"`
		SynchronousMode       bool `json:"synchronous_mode"`
		SynchronousModeStrict bool `json:"synchronous_mode_strict"`
	}
	if err := a.request(ctx, http.MethodGet, "/config", nil, &response); err != nil {
		return Config{}, err
	}
	return Config{Paused: response.Pause, SynchronousMode: response.SynchronousMode, SynchronousModeStrict: response.SynchronousModeStrict}, nil
}

func (a HTTPAPI) SetPaused(ctx context.Context, paused bool) error {
	payload, err := json.Marshal(map[string]bool{"pause": paused})
	if err != nil {
		return err
	}
	return a.request(ctx, http.MethodPatch, "/config", payload, nil)
}

func (a HTTPAPI) request(ctx context.Context, method, path string, payload []byte, output any) error {
	base, err := url.Parse(a.BaseURL)
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" || base.RawQuery != "" || base.Fragment != "" {
		return errors.New("valid Patroni HTTP(S) base URL is required")
	}
	base.Path = strings.TrimRight(base.Path, "/") + path
	request, err := http.NewRequestWithContext(ctx, method, base.String(), bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	client := a.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		return fmt.Errorf("Patroni HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	if output == nil {
		return nil
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
	if err := decoder.Decode(output); err != nil {
		return fmt.Errorf("decode Patroni response: %w", err)
	}
	return nil
}
