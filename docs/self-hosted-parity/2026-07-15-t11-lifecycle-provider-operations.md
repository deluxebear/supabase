# T11 lifecycle provider operations

## Scope and authority

T11 adds Fleet-only, versioned lifecycle providers. Embedded Studio, Cloud
Studio and CLI-mounted self-hosted behavior are unchanged. Platform desired
configuration remains authoritative for requested lifecycle state; Fleet
Control owns impact plans and durable execution state; the bound Stack Agent
owns only local execution evidence.

Lifecycle actions are independent capabilities. A deployment kind never
enables an action. Studio checks the Fleet profile, static
`lifecycleManagement` capability, project capability, project RBAC, active
organization/project/target binding and direct-managed ownership policy. Fleet
Control repeats project/binding/Agent capability checks and evaluates the
release compatibility matrix. The Agent compares the exact eleven-component
version snapshot before executing.

## Provider installation

The Agent lifecycle provider is an operator-installed executable configured
with all three settings:

```text
FLEET_AGENT_LIFECYCLE_PLUGIN=/usr/local/libexec/supabase-lifecycle-provider
FLEET_AGENT_LIFECYCLE_CAPABILITIES=runtime.restart,runtime.rollout
FLEET_AGENT_LIFECYCLE_COMPONENT_VERSIONS={...all eleven fields...}
```

The executable receives a fixed protocol, phase and capability as argv and a
strict typed request on stdin. It is never invoked through a shell. Browser
input cannot select an executable, command, path, namespace, container or
Kubernetes field manager. Install only a provider that owns the declared
target fields and implements observe, apply, verify and rollback phases.

Studio must use the same discovered version snapshot in the server-only
`FLEET_LIFECYCLE_COMPONENT_VERSIONS` setting. A mismatch fails with
`target_version_stale`; update both snapshots only after discovery confirms the
new deployment.

## Impact and confirmation

Every action first creates a ten-minute, project-scoped impact plan. The plan
contains the exact action, parameters, adapter, component versions, expected
impact, verification, rollback, and manual-intervention steps. Fleet Control
stores its canonical hash. Plans are single-use and execution rejects changed
parameters, versions, adapter, binding, expiry, project or hash. PostgreSQL
upgrade execution, replica removal and branch restore additionally require an
AAL2 session authenticated within ten minutes.

External delivery remains at-least-once. The Agent journal, idempotency key,
fencing token and desired generation protect side effects. Never claim
exactly-once execution.

## Failure and recovery

1. On apply failure, the Agent treats the provider as potentially partially
   applied and immediately attempts rollback to the observed pre-operation
   state. Keep the resulting evidence and create a fresh plan only after
   resolving the provider error.
2. On verification failure, the Agent invokes rollback with the redacted
   pre-operation observation. A verified rollback ends as `rolled-back`.
3. If rollback cannot be verified, the operation ends in
   `manual_intervention`; stop automatic retries and follow the plan's manual
   steps using out-of-band target access.
4. PostgreSQL upgrade rollback must use the provider-created recovery point;
   in-place binary downgrade is prohibited.
5. Network-policy recovery must retain out-of-band access because a bad ban
   may isolate the control plane.

## Rollback of T11 itself

Remove lifecycle capabilities from the Agent and restart it. The UI becomes
unavailable without deleting plans, operations, audit, or evidence. Do not
remove Fleet schema migration 7 or platform migration 18 after they have been
applied. Existing generic configuration, functions, backup and Embedded paths
continue independently.

## Verification

- Go contract tests cover unknown actions, bounds, version incompatibility,
  capability/adapter independence, exact/single-use plans and failure-injected
  rollback/manual intervention.
- Studio API tests cover project RBAC, AAL2 and Embedded route isolation.
- The release matrix is `apps/backup-operator/release/lifecycle-compatibility-v1.json`.
