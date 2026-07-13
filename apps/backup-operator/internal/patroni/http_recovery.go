package patroni

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

// HTTPRecoveryRuntime delegates node-local destructive operations to enrolled
// recovery agents. Patroni's public REST API remains the topology authority;
// these separate endpoints own systemd/pgBackRest actions on each node.
type HTTPRecoveryRuntime struct {
	Nodes       map[string]string
	BearerToken string
	Client      *http.Client
}

type NodeRollbackState struct {
	NodeID, QuarantineRef, SystemIdentifier, DataDirectoryDigest string
	Timeline                                                     uint64
	Primary                                                      bool
}

func (r HTTPRecoveryRuntime) PrepareRollback(ctx context.Context, node string, primary bool) (NodeRollbackState, error) {
	var state NodeRollbackState
	err := r.call(ctx, node, "/v1/recovery/rollback/prepare", map[string]bool{"primary": primary}, &state)
	if err == nil && (state.NodeID != node || state.QuarantineRef == "" || state.SystemIdentifier == "" || state.Timeline == 0 || state.DataDirectoryDigest == "") {
		err = errors.New("node rollback preparation returned incomplete identity evidence")
	}
	return state, err
}
func (r HTTPRecoveryRuntime) ValidateRollback(ctx context.Context, state NodeRollbackState) error {
	return r.call(ctx, state.NodeID, "/v1/recovery/rollback/validate", state, nil)
}
func (r HTTPRecoveryRuntime) RestoreRollback(ctx context.Context, state NodeRollbackState) error {
	return r.call(ctx, state.NodeID, "/v1/recovery/rollback/restore", state, nil)
}

func (r HTTPRecoveryRuntime) StopPatroni(ctx context.Context, node string) error {
	return r.call(ctx, node, "/v1/recovery/patroni/stop", nil, nil)
}
func (r HTTPRecoveryRuntime) StopPostgres(ctx context.Context, node string) error {
	return r.call(ctx, node, "/v1/recovery/postgres/stop", nil, nil)
}
func (r HTTPRecoveryRuntime) RestorePrimary(ctx context.Context, node string, plan contracts.RecoveryPlan) (RecoveredPrimary, error) {
	var result RecoveredPrimary
	err := r.call(ctx, node, "/v1/recovery/postgres/restore", map[string]any{"plan": plan, "repositoryReadOnly": true}, &result)
	return result, err
}
func (r HTTPRecoveryRuntime) StartPostgres(ctx context.Context, node string, isolated bool) error {
	return r.call(ctx, node, "/v1/recovery/postgres/start", map[string]bool{"isolated": isolated}, nil)
}
func (r HTTPRecoveryRuntime) ValidatePrimary(ctx context.Context, node string, plan contracts.RecoveryPlan) error {
	return r.call(ctx, node, "/v1/recovery/postgres/validate", map[string]any{"plan": plan}, nil)
}
func (r HTTPRecoveryRuntime) VerifyPromotedDataDir(ctx context.Context, node string) error {
	return r.call(ctx, node, "/v1/recovery/postgres/verify-promoted", nil, nil)
}
func (r HTTPRecoveryRuntime) StartPatroni(ctx context.Context, node string) error {
	return r.call(ctx, node, "/v1/recovery/patroni/start", nil, nil)
}
func (r HTTPRecoveryRuntime) RelaxLeaderAdmission(ctx context.Context, node string) (LeaderAdmissionState, error) {
	var result LeaderAdmissionState
	err := r.call(ctx, node, "/v1/recovery/patroni/relax-leader-admission", nil, &result)
	return result, err
}
func (r HTTPRecoveryRuntime) RestoreLeaderAdmission(ctx context.Context, node string, state LeaderAdmissionState) error {
	return r.call(ctx, node, "/v1/recovery/patroni/restore-leader-admission", state, nil)
}
func (r HTTPRecoveryRuntime) WaitPrimary(ctx context.Context, node string) error {
	return r.call(ctx, node, "/v1/recovery/patroni/wait-primary", nil, nil)
}
func (r HTTPRecoveryRuntime) FreshRebuild(ctx context.Context, node, primary string) error {
	return r.call(ctx, node, "/v1/recovery/patroni/fresh-rebuild", map[string]string{"primary": primary}, nil)
}
func (r HTTPRecoveryRuntime) ArchiveHealthy(ctx context.Context, node string) error {
	return r.call(ctx, node, "/v1/recovery/archive/check", nil, nil)
}

func (r HTTPRecoveryRuntime) call(ctx context.Context, node, path string, input, output any) error {
	base := r.Nodes[node]
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || node == "" {
		return fmt.Errorf("node %q has no valid recovery control URL", node)
	}
	loopback := u.Hostname() == "localhost" || net.ParseIP(u.Hostname()) != nil && net.ParseIP(u.Hostname()).IsLoopback()
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return errors.New("node recovery control requires HTTPS except on loopback")
	}
	u.Path = strings.TrimSuffix(u.Path, "/") + path
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	if strings.TrimSpace(r.BearerToken) != "" {
		request.Header.Set("Authorization", "Bearer "+r.BearerToken)
	}
	client := r.Client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		return fmt.Errorf("node %s recovery action returned HTTP %d", node, response.StatusCode)
	}
	if output == nil || response.StatusCode == http.StatusNoContent {
		return nil
	}
	return json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(output)
}

var _ RecoveryRuntime = HTTPRecoveryRuntime{}
