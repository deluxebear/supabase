package cloudnativepg

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

// HTTPControlAdapter is an explicit adapter for project-registry, isolation
// validation, and write-fencing control planes. Each operation has its own URL
// so deployments can grant narrowly scoped credentials.
type HTTPControlAdapter struct {
	RegistryURL, ValidatorURL, FencerURL string
	BearerToken                          string
	Client                               *http.Client
}

func (a HTTPControlAdapter) SwitchCNPGCluster(ctx context.Context, target contracts.TargetRef, cluster NamespacedName, uid string) error {
	return a.post(ctx, a.RegistryURL, map[string]any{"project_id": target.ProjectID, "target_id": target.TargetID, "namespace": cluster.Namespace, "cluster": cluster.Name, "uid": uid})
}
func (a HTTPControlAdapter) ValidateCNPGReplacement(ctx context.Context, plan RecoveryPlan, status ReplacementStatus) error {
	return a.post(ctx, a.ValidatorURL, map[string]any{"plan": plan, "status": status})
}
func (a HTTPControlAdapter) FenceCNPGSource(ctx context.Context, plan RecoveryPlan) error {
	return a.post(ctx, a.FencerURL, map[string]any{"plan_id": plan.ID, "project_id": plan.Target.ProjectID, "target_id": plan.Target.TargetID, "namespace": plan.Namespace, "cluster": plan.SourceCluster})
}
func (a HTTPControlAdapter) post(ctx context.Context, endpoint string, payload any) error {
	u, e := url.Parse(endpoint)
	if e != nil || u.Host == "" {
		return errors.New("control adapter URL is invalid")
	}
	host := u.Hostname()
	loopback := host == "localhost" || net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback()
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return errors.New("control adapter requires HTTPS except on loopback")
	}
	body, e := json.Marshal(payload)
	if e != nil {
		return e
	}
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if e != nil {
		return e
	}
	req.Header.Set("Content-Type", "application/json")
	if strings.TrimSpace(a.BearerToken) != "" {
		req.Header.Set("Authorization", "Bearer "+a.BearerToken)
	}
	client := a.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, e := client.Do(req)
	if e != nil {
		return e
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("control adapter returned HTTP %d", resp.StatusCode)
	}
	return nil
}
