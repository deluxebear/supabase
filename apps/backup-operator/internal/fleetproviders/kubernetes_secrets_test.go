package fleetproviders

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/sealedsecret"
)

type fakeWorkloads struct {
	secret       KubernetesSecretState
	podDigest    string
	applyErr     error
	rolloutReady func(call int) bool
	rolloutCalls int
	applied      []map[string][]byte
	restarts     []string
}

func (w *fakeWorkloads) GetSecret(context.Context, string, string) (KubernetesSecretState, error) {
	return w.secret, nil
}

func (w *fakeWorkloads) ApplySecret(_ context.Context, _, _ string, data map[string][]byte, digest string) error {
	if w.applyErr != nil {
		return w.applyErr
	}
	w.applied = append(w.applied, data)
	w.secret = KubernetesSecretState{Exists: true, Type: "Opaque", Data: data, Digest: digest, ManagedFields: map[string][]string{KubernetesSecretFieldManager: {"/data"}}}
	return nil
}

func (w *fakeWorkloads) GetDeploymentDigest(context.Context, string, string) (string, error) {
	return w.podDigest, nil
}

func (w *fakeWorkloads) RestartDeployment(_ context.Context, _, _ string, digest string) error {
	w.restarts = append(w.restarts, digest)
	w.podDigest = digest
	return nil
}

func (w *fakeWorkloads) DeploymentRolledOut(context.Context, string, string) (bool, error) {
	w.rolloutCalls++
	if w.rolloutReady == nil {
		return true, nil
	}
	return w.rolloutReady(w.rolloutCalls), nil
}

func sealedKubernetesRequest(t *testing.T, recipient *ecdh.PrivateKey, service, plaintext string) Request {
	t.Helper()
	digest := sha256.Sum256([]byte("kubernetes-secrets"))
	request := Request{
		OperationID: "op-3", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a",
		Domain: "functions", ExpectedGeneration: 1, DesiredDigest: hex.EncodeToString(digest[:]),
		Document: ConfigurationDocument{OwnershipMode: DirectManaged, Adapter: AdapterKubernetes, Kubernetes: &KubernetesDocument{}},
	}
	envelope, err := sealedsecret.Seal(rand.Reader, recipient.PublicKey().Bytes(), KubernetesSecretContext(request, service), []byte(plaintext))
	if err != nil {
		t.Fatal(err)
	}
	request.Document.Kubernetes.Secrets = []KubernetesSealedSecret{{Service: service, Sealed: SealedContent{Envelope: envelope, Fingerprint: "hmac"}}}
	return request
}

func secretProvider(recipient *ecdh.PrivateKey, workloads *fakeWorkloads) KubernetesProvider {
	return KubernetesProvider{Workloads: workloads, SecretRecipient: recipient, SecretNamespace: "supabase", SecretServices: []string{"functions"}, RolloutTimeout: time.Second, RolloutPollInterval: time.Millisecond}
}

func TestKubernetesSealedSecretAppliesRestartsAndConverges(t *testing.T) {
	recipient, _ := ecdh.X25519().GenerateKey(rand.Reader)
	workloads := &fakeWorkloads{}
	provider := secretProvider(recipient, workloads)
	request := sealedKubernetesRequest(t, recipient, "functions", `{"STRIPE_KEY":"sk_live_hunter2"}`)

	evidence, err := provider.Reconcile(context.Background(), request)
	if err != nil || !evidence.Applied || evidence.DriftState != "in-sync" {
		t.Fatalf("evidence = %+v, %v", evidence, err)
	}
	if len(workloads.applied) != 1 || string(workloads.applied[0]["STRIPE_KEY"]) != "sk_live_hunter2" {
		t.Fatalf("applied = %v", workloads.applied)
	}
	envelopeDigest := sealedsecret.Digest(request.Document.Kubernetes.Secrets[0].Sealed.Envelope)
	if len(workloads.restarts) != 1 || workloads.restarts[0] != envelopeDigest {
		t.Fatalf("restarts = %v", workloads.restarts)
	}
	observed := string(evidence.ObservedDocument)
	if strings.Contains(observed, "hunter2") || !strings.Contains(observed, "sealed:"+envelopeDigest) {
		t.Fatalf("observed document = %s", observed)
	}

	replay, err := provider.Reconcile(context.Background(), request)
	if err != nil || replay.Applied || len(workloads.applied) != 1 || len(workloads.restarts) != 1 {
		t.Fatalf("an applied secret must be in sync: %+v %v", replay, err)
	}

	observeOnly := request
	observeOnly.Document.OwnershipMode = ObserveOnly
	workloads.secret.Data = map[string][]byte{"STRIPE_KEY": []byte("changed")}
	drift, err := provider.Reconcile(context.Background(), observeOnly)
	if err != nil || drift.Applied || drift.DriftState != "drifted" || len(workloads.applied) != 1 {
		t.Fatalf("observe-only must report drift without writing: %+v %v", drift, err)
	}
}

func TestKubernetesSealedSecretRestoresAfterFailedRollout(t *testing.T) {
	recipient, _ := ecdh.X25519().GenerateKey(rand.Reader)
	previous := map[string][]byte{"STRIPE_KEY": []byte("old")}
	workloads := &fakeWorkloads{
		secret:       KubernetesSecretState{Exists: true, Type: "Opaque", Data: previous, Digest: "old-digest", ManagedFields: map[string][]string{KubernetesSecretFieldManager: {"/data"}}},
		podDigest:    "old-digest",
		rolloutReady: func(int) bool { return false },
	}
	provider := secretProvider(recipient, workloads)
	provider.RolloutTimeout = 20 * time.Millisecond
	_, err := provider.Reconcile(context.Background(), sealedKubernetesRequest(t, recipient, "functions", `{"STRIPE_KEY":"new"}`))
	if err == nil || !strings.Contains(err.Error(), "kubernetes_rollout_failed") || !strings.Contains(err.Error(), "restore them manually") {
		t.Fatalf("a rollout that never becomes available must fail: %v", err)
	}
	if len(workloads.applied) != 2 || string(workloads.applied[1]["STRIPE_KEY"]) != "old" {
		t.Fatalf("the previous Secret must be restored: %v", workloads.applied)
	}
	if workloads.restarts[len(workloads.restarts)-1] != "old-digest" {
		t.Fatalf("the previous pod template annotation must be restored: %v", workloads.restarts)
	}

	workloads.rolloutReady = func(call int) bool { return call > 3 }
	workloads.rolloutCalls = 0
	workloads.secret.Data, workloads.secret.Digest, workloads.podDigest = previous, "old-digest", "old-digest"
	workloads.applied = nil
	provider.RolloutTimeout = time.Second
	if _, err := provider.Reconcile(context.Background(), sealedKubernetesRequest(t, recipient, "functions", `{"STRIPE_KEY":"new"}`)); err != nil {
		t.Fatalf("a rollout that becomes available must succeed: %v", err)
	}
}

func TestKubernetesSealedSecretRefusesUnsafeTargets(t *testing.T) {
	recipient, _ := ecdh.X25519().GenerateKey(rand.Reader)
	other, _ := ecdh.X25519().GenerateKey(rand.Reader)
	cases := map[string]struct {
		provider  func(*fakeWorkloads) KubernetesProvider
		request   Request
		workloads *fakeWorkloads
		want      string
	}{
		"service outside allowlist": {func(w *fakeWorkloads) KubernetesProvider { return secretProvider(recipient, w) }, sealedKubernetesRequest(t, recipient, "auth", `{"A":"b"}`), &fakeWorkloads{}, "sealed_secret_not_allowed"},
		"other Agent key":           {func(w *fakeWorkloads) KubernetesProvider { return secretProvider(other, w) }, sealedKubernetesRequest(t, recipient, "functions", `{"A":"b"}`), &fakeWorkloads{}, sealedsecret.ErrWrongRecipient.Error()},
		"no Agent key":              {func(w *fakeWorkloads) KubernetesProvider { return secretProvider(nil, w) }, sealedKubernetesRequest(t, recipient, "functions", `{"A":"b"}`), &fakeWorkloads{}, "sealed_secret_unavailable"},
		"not a JSON object":         {func(w *fakeWorkloads) KubernetesProvider { return secretProvider(recipient, w) }, sealedKubernetesRequest(t, recipient, "functions", `["A"]`), &fakeWorkloads{}, "sealed_secret_invalid"},
		"invalid key":               {func(w *fakeWorkloads) KubernetesProvider { return secretProvider(recipient, w) }, sealedKubernetesRequest(t, recipient, "functions", `{"A B":"c"}`), &fakeWorkloads{}, "sealed_secret_invalid"},
		"operator-owned Secret": {func(w *fakeWorkloads) KubernetesProvider { return secretProvider(recipient, w) }, sealedKubernetesRequest(t, recipient, "functions", `{"A":"b"}`),
			&fakeWorkloads{secret: KubernetesSecretState{Exists: true, Type: "Opaque", ManagedFields: map[string][]string{"kubectl-create": {"/data", "/data/A"}}}}, "ownership"},
	}
	for name, tc := range cases {
		_, err := tc.provider(tc.workloads).Reconcile(context.Background(), tc.request)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			var ownership *OwnershipConflictError
			if !(tc.want == "ownership" && errors.As(err, &ownership)) {
				t.Fatalf("%s: expected %q, got %v", name, tc.want, err)
			}
		}
		if len(tc.workloads.applied) != 0 || len(tc.workloads.restarts) != 0 {
			t.Fatalf("%s: nothing may be written", name)
		}
	}
}

func TestDeploymentRolledOut(t *testing.T) {
	deployment := func(generation, observed, replicas, updated, total, available int64) map[string]any {
		return map[string]any{
			"metadata": map[string]any{"generation": generation},
			"spec":     map[string]any{"replicas": replicas},
			"status":   map[string]any{"observedGeneration": observed, "updatedReplicas": updated, "replicas": total, "availableReplicas": available},
		}
	}
	if !deploymentRolledOut(deployment(3, 3, 2, 2, 2, 2)) {
		t.Fatal("a complete rollout must be ready")
	}
	for name, object := range map[string]map[string]any{
		"stale generation":     deployment(4, 3, 2, 2, 2, 2),
		"old pods remain":      deployment(3, 3, 2, 2, 3, 2),
		"new pods unavailable": deployment(3, 3, 2, 2, 2, 1),
	} {
		if deploymentRolledOut(object) {
			t.Fatalf("%s reported ready", name)
		}
	}
}
