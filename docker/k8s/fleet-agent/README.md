# Fleet Agent on Kubernetes

Runs a Fleet Agent in the `supabase` namespace next to the
[single-project stack](../single-project/README.md), so a Fleet Studio can
manage it. The Agent connects out to Fleet Control over mTLS gRPC; nothing
connects in.

What it enables today: `runtime.config.reconcile` with sealed secrets.
Edge Function secrets and Auth settings saved in Studio are sealed to this
Agent, written to the Secrets `supabase-fleet-functions-secrets` and
`supabase-fleet-auth-secrets`, and rolled out to the `functions` and `auth`
Deployments. Fleet Control never sees them in plaintext. It also deploys Edge
Functions onto a shared volume and manages database security.

## What gets deployed

| Manifest             | Resources                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `10-rbac.yaml`       | ServiceAccount, Role, RoleBinding `fleet-agent`: the Fleet-owned Secrets and the `functions` and `auth` Deployments |
| `20-state.yaml`      | PVC `fleet-agent-state` (trust, journal, lock, secret recipient key) and the enrollment capabilities   |
| `25-functions-volume.yaml` | PVC `fleet-functions`: Edge Function revisions, shared with the `functions` pods |
| `30-enroll-job.yaml` | One-time enrollment Job (run by `deploy.sh` only until it succeeds)                                    |
| `40-agent.yaml`      | Deployment `fleet-agent`: one replica, `Recreate`, non-root, read-only root filesystem                 |
| `functions-patch.yaml` | Patch `deploy.sh` applies to the single-project `functions` Deployment to serve the shared volume |

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
   `runtime.config.reconcile`. On the Edge Function secrets page and the Auth
   pages, apply the saved settings.

Re-running `deploy.sh` is safe: after a successful enrollment it records the
ConfigMap `fleet-agent-enrollment-state`, deletes the token Secret, and only
updates the identity and the Deployment.

## Delivering secrets to more Deployments

Add the Deployment to `FLEET_AGENT_KUBERNETES_SECRET_SERVICES`, add its Secret
(`supabase-fleet-<name>-secrets`) and Deployment names to the `resourceNames`
in `10-rbac.yaml`, and give the Deployment an optional `envFrom` for that
Secret, listed after any other `envFrom` source (see
`../single-project/11-core.yaml`). Entries under `env` win over `envFrom`, so a
delivered variable has no effect if the manifest also sets it with `env`.

## Enrolling again

Enrollment never overwrites existing trust files. To enroll again, for example
after the Agent was revoked, delete the Deployment, the PVC
`fleet-agent-state`, and the ConfigMap `fleet-agent-enrollment-state`, then run
`deploy.sh` with a new token. The new volume also holds a new secret recipient
key, so apply sealed secrets from Studio again afterwards; envelopes sealed to
the old key fail with `sealed_secret_recipient_mismatch`.

## Edge Function deployment

`functions.deploy` writes to the PVC `fleet-functions`, which the Agent and the
`functions` pods share:

- The Agent writes each revision once under
  `<project key>/.fleet-artifacts/<slug>/revisions/<digest>`, activates it as
  `<project key>/<slug>` with a `.fleet-runtime-revision` marker, waits for the
  `functions` Deployment to be available, and invokes the function through
  Kong with the service role key. A failed probe restores the previous
  revision.
- `deploy.sh` patches the `functions` Deployment (`functions-patch.yaml`) to
  mount `<project key>` of that volume at `/home/deno/functions` and to set
  `FUNCTIONS_NO_MODULE_CACHE=true`. The main service reads the marker on every
  request, so a deploy needs no restart. `main/index.ts` still comes from the
  `functions-main` ConfigMap. The project key is the first 12 bytes of
  SHA-256 of the project ref, in hex.
- The volume is `ReadWriteOnce`, so the patch pins the `functions` pods to the
  Agent's node with pod affinity, and an init container gives the Agent (uid
  65532) the project directory. With a `ReadWriteMany` storage class, change
  `accessModes` in `25-functions-volume.yaml` and remove the affinity from
  `functions-patch.yaml` to spread the pods.

Re-running `../single-project/deploy.sh` keeps the patch: `kubectl apply` only
removes fields it applied itself.

## Database security

`database.security.reconcile` sets Supavisor SSL enforcement and upstream CA,
the network CIDR allowlist, and pool limits in `_supabase._supavisor.tenants`,
and rotates the `postgres` and `supabase_read_only_user` passwords. The Agent
uses the same runtime as on Compose, over the `db` and `supavisor` Services:

- The admin and pooler DSNs are built from `supabase-env`.
- Its state (`database-security.json`, no credentials) lives on the state
  volume.
- CA files come from the ConfigMap `fleet-database-tls-ca`, which `deploy.sh`
  builds from `FLEET_AGENT_DATABASE_TLS_CA_DIR`. Studio refers to a CA by file
  name, and only files in that ConfigMap are accepted.
- Password rotations arrive sealed to the Agent. A rotation changes the role
  in Postgres and Studio's stored connection, not `supabase-env`: update
  `POSTGRES_PASSWORD` there before the next `deploy.sh`, or services that read
  it (and this Agent's DSNs) keep the old password after a restart.

## Not included

- Runtime inventory and lifecycle actions: their providers are Compose-only.

`apps/backup-operator/cmd/fleet-agent/manifests_test.go` decodes these
manifests strictly against the Kubernetes API types and checks that every
`FLEET_AGENT_*` variable is one the Agent reads, that the Role covers the
allowlisted services, and that the Agent and the patched `functions` Deployment
mount the same function volume.
