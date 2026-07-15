# T10 capacity and control-plane operations

T10 defines and tests the first production operating envelope for Fleet. It
does not add a browser-visible management capability. Cloud, Embedded Studio,
and CLI behavior are unchanged. Fleet operations continue to reach the queue
only after canonical Fleet profile, static capability, current project
capability, project-scoped RBAC, organization/project/target/binding isolation,
ownership, and typed-contract checks. Capacity is an additional fail-closed
guard, never a substitute for authorization.

## Authority and isolation

The platform store remains authoritative for desired state and its durable
outbox. Platform migration 17 rejects new work above organization or management
target queue quotas and applies equal-jitter retry scheduling. Fleet Control
schema 6 owns execution admission, Agent sessions, immutable artifact byte
quotas, live operation events, and its independent archives. Backup Operator
retains exclusive ownership of backup/recovery jobs, evidence, and retention.
No mutable record is copied into a second authoritative store.

Quota checks use the organization and target recorded by the active management
binding. Idempotent replays bypass new-work quota checks and return the original
operation. An Agent reconnect may reclaim its already-active durable task even
when the global pool is full; a different task waits. Capacity rejection uses
`capacity_exceeded`, never a false success.

## Tested envelope and safe configuration

| Boundary | Default | Published/tested limit |
| --- | ---: | ---: |
| Attached projects | 100 tested | 100 |
| Distinct active execution Agents | one per binding | 100 under this topology |
| Concurrent Agent sessions/reconnect overlap | 300 | 300 |
| Concurrent target-side operations | 20 | 20 |
| Concurrent operations per target | 2 | configurable lower than global |
| Queued operations per organization | 1,000 | 1,000 |
| Queued operations per target | 100 | 100 |
| Live events per operation | 10,000 | 10,000 |
| Artifact bytes per project / organization | 1 GiB / 20 GiB | 1 GiB / 20 GiB |
| Studio metrics fan-out | 8 | safe maximum 32 |

Parser maxima are safety rails, not published capacity. Raising a published
default requires a new load result and capacity note. Lower limits are valid.
Production Compose exposes the `FLEET_CONTROL_MAX_*`, retention, Backup Operator
runtime concurrency, and `SELF_PLATFORM_METRICS_CONCURRENCY` settings.

T7 intentionally permits one active execution Agent identity per binding. The
original architecture wording combined 100 attached projects with 300 distinct
connected Agents, which cannot coexist with that constraint. ADR-015 preserves
the binding isolation and defines 300 as concurrent authenticated Agent sessions
during reconnect/certificate overlap. A future multi-node provider must add an
explicit node-to-operation routing contract and a superseding ADR before it may
advertise multiple active execution Agents per binding.

## Backpressure, retry, and retention

- Fleet Agent reconnect uses exponential equal jitter between 50% and 100% of
  the current delay, from 1 second to 30 seconds by default.
- Platform outbox retry uses durable equal jitter capped at 5 minutes. Delivery
  remains at-least-once and protected by the original idempotency key.
- Fleet Control admits at most 20 applying operations globally and the lower
  per-target limit. Offline targets keep queued durable work but cannot occupy
  an execution slot.
- Backup Operator's in-process worker pool defaults to four and rejects values
  above 20. Periodic worker failures exponentially back off with jitter.
- Studio reads project refs once per metrics cycle, processes them through a
  bounded worker pool, and records per-project failure backoff so one offline
  stack cannot consume the whole sampler.
- Fleet Control keeps the newest 10,000 live events for every operation. Older
  overflow, terminal events past 30 days, and audits past 365 days move in
  bounded transactions to independent archive tables. The operation snapshot
  remains the durable reconnect fallback.

## SLOs and alerts

The first release objectives are:

- project/control cached reads: p95 below 500 ms inside the control plane;
- a committed operation event visible within 5 seconds;
- Fleet Control API availability: 99.9% monthly, excluding declared maintenance;
- no duplicate durable task/result state during a 300-session reconnect storm;
- no capacity rejection during steady state below 80% of a configured limit.

Fleet Control exposes `/metrics`. Alert rules cover Agent session saturation,
operation saturation, queue backlog, and capacity rejection. High-cardinality
project, organization, target, Agent, and operation identities remain only in
structured logs/traces, never Prometheus labels. On an alert, identify the
affected target from correlation logs, restore connectivity, and let durable
work drain. Do not raise limits before recording a new load result.

## Independent disaster recovery

The recovery set contains four independently protected data classes:

1. platform PostgreSQL plus platform JWT/encryption/assertion material;
2. Fleet Control PostgreSQL plus its artifact volume;
3. Backup Operator PostgreSQL plus repository credentials/evidence;
4. Agent CA and enrollment server certificate/private keys.

`docker/self-platform/scripts/verify-control-plane-dr.sh` creates logical
backups of all three stores, restores each into a scratch database, verifies
its migration ledger, creates a checksum-protected authority bundle, proves the
live schema-6 readiness endpoint, and proves a Fleet Control instance without
the CA private key fails before readiness. It never stops or restores a managed
stack. Store dumps without the matching keys are incomplete recovery media.

After a real restore, keep dispatchers stopped until all stores and keys pass
readiness, compare platform outbox/Fleet operation cursors, restart one
dispatcher, then allow Agents to reconnect with jitter. Unknown execution state
remains queued, orphaned, or manual intervention; never mark it successful from
database restoration alone.

## Verification

```bash
apps/backup-operator/scripts/run-t10-capacity-load.sh

cd apps/backup-operator
make generate
make check-generated
make build
make test
go vet ./...

cd ../..
pnpm --filter studio exec vitest run \
  lib/api/self-platform/metrics.test.ts \
  lib/api/self-platform/desired-state.test.ts
pnpm --filter studio exec tsc --noEmit -p tsconfig.json
pnpm build --filter=studio

# Requires a running disposable production control-plane Compose project.
docker/self-platform/scripts/verify-control-plane-dr.sh
```

The load harness asserts 100 project control reads, 300 admitted concurrent
sessions with the next rejected, 20 applying operations with the next queued,
per-organization/per-target quota isolation, 10,000-event live retention,
sub-500 ms p95 cached reads, sub-5-second event visibility, randomized reconnect
distribution, and bounded Backup Operator execution.
