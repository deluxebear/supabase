package writefence

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

// HTTPProvider uses an independently deployed, typed fencing control plane.
// The returned handle is opaque and every verify/release call is authoritative.
type HTTPProvider struct {
	ProviderID, BaseURL, BearerToken string
	Client                           *http.Client
}

func (p HTTPProvider) ID() string { return p.ProviderID }

func (p HTTPProvider) Engage(ctx context.Context, target contracts.TargetRef, topology contracts.TopologySnapshot) (contracts.FenceHandle, error) {
	var handle contracts.FenceHandle
	err := p.post(ctx, "/v1/fences/engage", map[string]any{"target": target, "topology": topology}, &handle)
	if err == nil && (handle.ID == "" || handle.Target != target || !time.Now().Before(handle.Expires)) {
		err = errors.New("fence control plane returned an invalid handle")
	}
	return handle, err
}

func (p HTTPProvider) Verify(ctx context.Context, handle contracts.FenceHandle) (contracts.FenceEvidence, error) {
	var evidence contracts.FenceEvidence
	err := p.post(ctx, "/v1/fences/verify", map[string]any{"handle": handle}, &evidence)
	if err == nil {
		err = evidence.Validate(time.Now())
	}
	return evidence, err
}

func (p HTTPProvider) Release(ctx context.Context, handle contracts.FenceHandle) (contracts.Evidence, error) {
	var evidence contracts.Evidence
	err := p.post(ctx, "/v1/fences/release", map[string]any{"handle": handle}, &evidence)
	if err == nil {
		err = evidence.Validate(time.Now())
	}
	return evidence, err
}

func (p HTTPProvider) post(ctx context.Context, path string, input, output any) error {
	u, err := url.Parse(p.BaseURL)
	if err != nil || u.Host == "" || p.ProviderID == "" {
		return errors.New("fence provider ID and absolute URL are required")
	}
	loopback := u.Hostname() == "localhost" || net.ParseIP(u.Hostname()) != nil && net.ParseIP(u.Hostname()).IsLoopback()
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return errors.New("fence control plane requires HTTPS except on loopback")
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
	if strings.TrimSpace(p.BearerToken) != "" {
		request.Header.Set("Authorization", "Bearer "+p.BearerToken)
	}
	client := p.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("fence control plane returned HTTP %d", response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(output)
}

var _ contracts.WriteFenceProvider = HTTPProvider{}
