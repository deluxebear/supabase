package fleetproviders

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/sealedsecret"
)

const (
	// KubernetesSecretFieldManager owns Fleet-delivered Secrets and the
	// restart annotation. It is separate from KubernetesFieldManager so that
	// applying one never drops fields the other owns.
	KubernetesSecretFieldManager = "supabase-fleet-secrets"
	// KubernetesSecretDigestAnnotation carries the envelope digest on the
	// Secret and on the Deployment pod template, which restarts the pods.
	KubernetesSecretDigestAnnotation = "supabase.com/fleet-secrets-digest"
	defaultKubernetesRolloutTimeout  = 3 * time.Minute
)

var kubernetesSecretKeyPattern = regexp.MustCompile(`^[-._a-zA-Z0-9]{1,253}$`)

// KubernetesSecretState is what the Agent observes of a Fleet-delivered
// Secret. Data never leaves the Agent.
type KubernetesSecretState struct {
	Exists        bool
	Type          string
	Data          map[string][]byte
	Digest        string
	ManagedFields map[string][]string
}

// KubernetesWorkloadClient reads and writes the Secrets and Deployments that
// sealed secrets target, all in the Agent's namespace.
type KubernetesWorkloadClient interface {
	GetSecret(ctx context.Context, namespace, name string) (KubernetesSecretState, error)
	ApplySecret(ctx context.Context, namespace, name string, data map[string][]byte, digest string) error
	GetDeploymentDigest(ctx context.Context, namespace, name string) (string, error)
	RestartDeployment(ctx context.Context, namespace, name, digest string) error
	DeploymentRolledOut(ctx context.Context, namespace, name string) (bool, error)
}

// KubernetesSecretName is the Secret that carries a service's delivered
// environment variables. Workloads read it with an optional envFrom.
func KubernetesSecretName(service string) string {
	return "supabase-fleet-" + service + "-secrets"
}

type openedKubernetesSecret struct {
	Service string
	Data    map[string][]byte
	Digest  string
}

type kubernetesSecretObservation struct {
	Service      string `json:"service"`
	Secret       string `json:"secret"`
	DesiredMatch bool   `json:"desiredMatch"`
	// SealedDigest names the envelope; the Secret data is never reported.
	SealedDigest string `json:"sealedDigest"`
}

type kubernetesSecretPlan struct {
	secret       openedKubernetesSecret
	previous     KubernetesSecretState
	previousPod  string
	needsApply   bool
	needsRollout bool
	observation  kubernetesSecretObservation
}

// openKubernetesSecrets decrypts every sealed secret before anything is read
// or written, so a bad envelope changes nothing.
func (p KubernetesProvider) openKubernetesSecrets(request Request) ([]openedKubernetesSecret, error) {
	secrets := request.Document.Kubernetes.Secrets
	if len(secrets) == 0 {
		return nil, nil
	}
	if p.SecretRecipient == nil {
		return nil, errors.New("sealed_secret_unavailable: this Agent has no secret recipient key")
	}
	if p.Workloads == nil || p.SecretNamespace == "" {
		return nil, errors.New("Kubernetes sealed secrets are not configured on this Agent")
	}
	opened := make([]openedKubernetesSecret, 0, len(secrets))
	for _, secret := range secrets {
		if !containsString(p.SecretServices, secret.Service) {
			return nil, fmt.Errorf("sealed_secret_not_allowed: service %q is not in the Agent secret allowlist", secret.Service)
		}
		plaintext, err := sealedsecret.Open(p.SecretRecipient, KubernetesSecretContext(request, secret.Service), secret.Sealed.Envelope)
		if err != nil {
			return nil, err
		}
		data, err := decodeKubernetesSecretData(plaintext)
		if err != nil {
			return nil, err
		}
		opened = append(opened, openedKubernetesSecret{Service: secret.Service, Data: data, Digest: sealedsecret.Digest(secret.Sealed.Envelope)})
	}
	return opened, nil
}

// KubernetesSecretContext binds a sealed Kubernetes secret to the project,
// binding, configuration domain, and service.
func KubernetesSecretContext(request Request, service string) sealedsecret.Context {
	return sealedsecret.Context{ProjectRef: request.ProjectRef, BindingID: request.BindingID, Domain: request.Domain, Path: "kubernetes/secrets/" + service}
}

func decodeKubernetesSecretData(plaintext []byte) (map[string][]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(plaintext))
	var values map[string]string
	if err := decoder.Decode(&values); err != nil || values == nil {
		return nil, errors.New("sealed_secret_invalid: a Kubernetes sealed secret must be a JSON object of strings")
	}
	data := make(map[string][]byte, len(values))
	for key, value := range values {
		if !kubernetesSecretKeyPattern.MatchString(key) {
			return nil, fmt.Errorf("sealed_secret_invalid: Kubernetes Secret key %q is invalid", key)
		}
		data[key] = []byte(value)
	}
	return data, nil
}

func (p KubernetesProvider) planKubernetesSecrets(ctx context.Context, secrets []openedKubernetesSecret) ([]kubernetesSecretPlan, []Conflict, error) {
	plans := make([]kubernetesSecretPlan, 0, len(secrets))
	conflicts := make([]Conflict, 0)
	for _, secret := range secrets {
		name := KubernetesSecretName(secret.Service)
		identity := "core/v1/secrets/" + p.SecretNamespace + "/" + name
		current, err := p.Workloads.GetSecret(ctx, p.SecretNamespace, name)
		if err != nil {
			return nil, nil, fmt.Errorf("read Secret %s: %w", name, err)
		}
		podDigest, err := p.Workloads.GetDeploymentDigest(ctx, p.SecretNamespace, secret.Service)
		if err != nil {
			return nil, nil, fmt.Errorf("read Deployment %s: %w", secret.Service, err)
		}
		plan := kubernetesSecretPlan{secret: secret, previous: current, previousPod: podDigest}
		if current.Exists && current.Type != "" && current.Type != "Opaque" {
			conflicts = append(conflicts, kubernetesConflict(identity, "/type", "unknown", "The Secret exists with a type other than Opaque"))
		}
		for manager, fields := range current.ManagedFields {
			if manager == KubernetesSecretFieldManager {
				continue
			}
			for _, field := range fields {
				if field == "/data" || strings.HasPrefix(field, "/data/") || field == "/stringData" || strings.HasPrefix(field, "/stringData/") {
					conflicts = append(conflicts, kubernetesConflict(identity, field, manager, "Another Kubernetes field manager owns the Secret data"))
					break
				}
			}
		}
		plan.needsApply = !current.Exists || current.Digest != secret.Digest || !sameSecretData(current.Data, secret.Data)
		plan.needsRollout = plan.needsApply || podDigest != secret.Digest
		plan.observation = kubernetesSecretObservation{Service: secret.Service, Secret: identity, DesiredMatch: !plan.needsApply && !plan.needsRollout, SealedDigest: "sealed:" + secret.Digest}
		plans = append(plans, plan)
	}
	return plans, conflicts, nil
}

// applyKubernetesSecrets writes each drifted Secret, restarts its Deployment,
// and waits for the rollout. A failed rollout restores the previous Secret
// and pod template annotation.
func (p KubernetesProvider) applyKubernetesSecrets(ctx context.Context, plans []kubernetesSecretPlan) error {
	for _, plan := range plans {
		if !plan.needsApply && !plan.needsRollout {
			continue
		}
		name := KubernetesSecretName(plan.secret.Service)
		if plan.needsApply {
			if err := p.Workloads.ApplySecret(ctx, p.SecretNamespace, name, plan.secret.Data, plan.secret.Digest); err != nil {
				if isKubernetesOwnershipConflict(err) {
					return &OwnershipConflictError{Conflicts: []Conflict{kubernetesConflict("core/v1/secrets/"+p.SecretNamespace+"/"+name, "/data", "unknown", "Kubernetes rejected server-side apply because field ownership changed")}}
				}
				return fmt.Errorf("apply Secret %s: %w", name, err)
			}
		}
		rolloutErr := p.Workloads.RestartDeployment(ctx, p.SecretNamespace, plan.secret.Service, plan.secret.Digest)
		if rolloutErr == nil {
			rolloutErr = p.waitForRollout(ctx, plan.secret.Service)
		}
		if rolloutErr == nil {
			continue
		}
		if restoreErr := p.restoreKubernetesSecret(ctx, plan); restoreErr != nil {
			return fmt.Errorf("kubernetes_rollout_failed: Deployment %s did not become available (%v), and restoring the previous secrets failed (%v); restore them manually", plan.secret.Service, rolloutErr, restoreErr)
		}
		return fmt.Errorf("kubernetes_rollout_failed: Deployment %s did not become available with the new secrets and was restored: %w", plan.secret.Service, rolloutErr)
	}
	return nil
}

func (p KubernetesProvider) restoreKubernetesSecret(ctx context.Context, plan kubernetesSecretPlan) error {
	if plan.needsApply {
		previous := plan.previous.Data
		if previous == nil {
			previous = map[string][]byte{}
		}
		if err := p.Workloads.ApplySecret(ctx, p.SecretNamespace, KubernetesSecretName(plan.secret.Service), previous, plan.previous.Digest); err != nil {
			return err
		}
	}
	if err := p.Workloads.RestartDeployment(ctx, p.SecretNamespace, plan.secret.Service, plan.previousPod); err != nil {
		return err
	}
	return p.waitForRollout(ctx, plan.secret.Service)
}

func (p KubernetesProvider) waitForRollout(ctx context.Context, deployment string) error {
	timeout := p.RolloutTimeout
	if timeout <= 0 {
		timeout = defaultKubernetesRolloutTimeout
	}
	interval := p.RolloutPollInterval
	if interval <= 0 {
		interval = 2 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		ready, err := p.Workloads.DeploymentRolledOut(ctx, p.SecretNamespace, deployment)
		if err != nil {
			return err
		}
		if ready {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("rollout of %s timed out", deployment)
		case <-time.After(interval):
		}
	}
}

func sameSecretData(left, right map[string][]byte) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		other, ok := right[key]
		if !ok || !bytes.Equal(value, other) {
			return false
		}
	}
	return true
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func sortedSecretObservations(plans []kubernetesSecretPlan) []kubernetesSecretObservation {
	observations := make([]kubernetesSecretObservation, 0, len(plans))
	for _, plan := range plans {
		observations = append(observations, plan.observation)
	}
	sort.Slice(observations, func(i, j int) bool { return observations[i].Service < observations[j].Service })
	return observations
}
