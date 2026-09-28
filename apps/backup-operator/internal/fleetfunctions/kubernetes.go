package fleetfunctions

import (
	"context"
	"errors"
	"time"
)

// KubernetesProvider deploys functions onto a volume shared by the Agent and
// the Edge Runtime pods (ReadWriteMany, or ReadWriteOnce with every pod on one
// node), using the same layout as Compose. The Edge Runtime serves a new
// revision from the next request on, without a restart; Runtime only confirms
// the Deployment is available before the invocation probe.
type KubernetesProvider struct {
	ArtifactRoot string
	Runtime      RolloutRuntime
	Prober       Prober
	Switch       func(string, string) error
	Now          func() time.Time
}

func (KubernetesProvider) Adapter() AdapterKind { return AdapterKubernetes }

func (p KubernetesProvider) Deploy(ctx context.Context, request Request) (Evidence, error) {
	if err := request.Validate(); err != nil {
		return Evidence{}, err
	}
	if p.ArtifactRoot == "" || p.Runtime == nil || p.Prober == nil {
		return Evidence{}, errors.New("Kubernetes function provider is not configured")
	}
	return deployOnSharedRoot(ctx, request, sharedRootDeployment{
		Root: p.ArtifactRoot, Adapter: AdapterKubernetes, Prober: p.Prober, Switch: p.Switch, Now: p.Now,
		Ready: func(ctx context.Context) error {
			return p.Runtime.WaitForRollout(ctx, request.Deployment.Slug, request.Deployment.ArtifactDigest)
		},
	})
}
