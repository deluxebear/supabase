# Fleet Agent on Kubernetes

Runs a Fleet Agent in the `supabase` namespace next to the
[single-project stack](../single-project/README.md), so a Fleet Studio can
manage it. The Agent connects out to Fleet Control over mTLS gRPC; nothing
connects in.

What it enables today: `runtime.config.reconcile` with sealed secrets.
Edge Function secrets saved in Studio are sealed to this Agent, written to the
Secret `supabase-fleet-functions-secrets`, and rolled out to the `functions`
Deployment. Fleet Control never sees them in plaintext.

## What gets deployed

| Manifest             | Resources                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `10-rbac.yaml`       | ServiceAccount, Role, RoleBinding `fleet-agent`: the Fleet-owned Secret and the `functions` Deployment |
| `20-state.yaml`      | PVC `fleet-agent-state` (trust, journal, lock, secret recipient key) and the enrollment capabilities   |
| `30-enroll-job.yaml` | One-time enrollment Job (run by `deploy.sh` only until it succeeds)                                    |
| `40-agent.yaml`      | Deployment `fleet-agent`: one replica, `Recreate`, non-root, read-only root filesystem                 |

`deploy.sh` creates the ConfigMap `fleet-agent-identity` and, during
enrollment, the Secret `fleet-agent-enrollment` from your local
`fleet-agent.env`. Neither is committed.

## Deploy

1. In Studio, attach the project as a Kubernetes target and create an
   enrollment token. Note the organization, project, target, binding, and Agent
   ids.
2. Copy `fleet-agent.env.example` to `fleet-agent.env`, fill it in, and save
   the Fleet Control enrollment CA next to it (`enrollment-ca.crt`).
3. Run:

   ```bash
   cd docker/k8s/fleet-agent
   ./deploy.sh
   ```

4. In Studio, the binding reports the Agent online with
   `runtime.config.reconcile`. On the Edge Function secrets page, apply the
   saved secrets.

Re-running `deploy.sh` is safe: after a successful enrollment it records the
ConfigMap `fleet-agent-enrollment-state`, deletes the token Secret, and only
updates the identity and the Deployment.

## Delivering secrets to more Deployments

Add the Deployment to `FLEET_AGENT_KUBERNETES_SECRET_SERVICES`, add its Secret
(`supabase-fleet-<name>-secrets`) and Deployment names to the `resourceNames`
in `10-rbac.yaml`, and give the Deployment an optional `envFrom` for that
Secret (see `../single-project/19-functions.yaml`). Entries under `env` win over
`envFrom`, so a delivered variable has no effect if the manifest also sets it
with `env`. That is why Auth settings are not delivered on Kubernetes yet.

## Enrolling again

Enrollment never overwrites existing trust files. To enroll again, for example
after the Agent was revoked, delete the Deployment, the PVC
`fleet-agent-state`, and the ConfigMap `fleet-agent-enrollment-state`, then run
`deploy.sh` with a new token. The new volume also holds a new secret recipient
key, so apply sealed secrets from Studio again afterwards; envelopes sealed to
the old key fail with `sealed_secret_recipient_mismatch`.

## Not included

- Edge Function deployment (`functions.deploy`): it needs an artifact volume
  shared between the Agent and the `functions` pods, and the Edge Runtime probe
  settings. The single-project stack serves functions from a ConfigMap.
- Database security, runtime inventory, and lifecycle actions: their providers
  are Compose-only.

`apps/backup-operator/cmd/fleet-agent/manifests_test.go` decodes these
manifests strictly against the Kubernetes API types and checks that every
`FLEET_AGENT_*` variable is one the Agent reads and that the Role covers the
allowlisted services.
