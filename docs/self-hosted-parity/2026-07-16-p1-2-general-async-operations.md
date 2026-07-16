# P1-2 General asynchronous operations

P1-2 closes the shared execution lifecycle used by Fleet configuration, function, lifecycle, database security, backup, restore, and upgrade providers. Fleet Control remains the durable execution authority; the platform outbox remains the desired-state dispatch authority; the Agent journal remains the data-plane duplicate-execution guard.

## Public lifecycle

Fleet Control schema 9 exposes exactly these operation states:

| State | Meaning |
| --- | --- |
| `queued` | Persisted and waiting for an eligible Agent. |
| `running` | Claimed by one Agent with a durable task and attempt identity. |
| `succeeded` | The Agent returned successful typed evidence. |
| `failed` | The Agent returned failure or manual-intervention evidence. |
| `cancelled` | Cancelled before an Agent claimed the operation. |
| `timed_out` | The operation deadline elapsed while queued or running. |

Running operations reject cancellation. The Agent protocol cannot prove that an in-flight mutating provider has stopped or rolled back, so returning `cancelled` would be false success. Failed operations may be explicitly retried; each retry preserves the immutable operation snapshot and idempotency identity while creating the next `operation_attempts` row and task suffix.

## Durability and replay

- `(project_ref, idempotency_key)` is unique. An exact replay returns the existing operation even if the Agent is offline. Reusing the key for another operation revision or digest returns `409 idempotency_conflict`.
- A fresh Agent claim increments `attempts` and creates `operation_id:attempt`. Reconnecting the same Agent to a running task returns the same task and does not increment attempts.
- Attempt terminal state, typed evidence, error code, Agent identity, and timestamps are stored separately from the current operation projection.
- Control-plane restart recovery reads queued and running work from the independent Fleet PostgreSQL recovery domain. Agent restart recovery reads the local durable journal and replays the recorded task result.
- Deadlines are persisted at creation or retry. Fleet Control expires overdue work to `timed_out`, records the attempt when one exists, and rejects a late completion.
- Create, retry, cancel, and timeout transitions emit project-scoped operation events, audit actions, and the original correlation identity.

## APIs

- `POST /platform/fleet/v1/projects/{projectRef}/operations`
- `GET /platform/fleet/v1/projects/{projectRef}/operations/{operationId}`
- `POST /platform/fleet/v1/projects/{projectRef}/operations/{operationId}/cancel`
- `POST /platform/fleet/v1/projects/{projectRef}/operations/{operationId}/retry`
- `GET /platform/fleet/v1/projects/{projectRef}/operations/{operationId}/events`

Studio exposes project-RBAC-protected Fleet-only proxies for read, cancel, and retry. The response is validated against the complete operation contract and includes attempt history, correlation ID, deadline, terminal evidence, and error code. Embedded Studio continues to return the existing missing-route behavior.

## Verification

Automated coverage includes SQLite migration upgrade and checksum enforcement, PostgreSQL-compatible migration SQL, project isolation, exact idempotent replay while the Agent is offline, attempt allocation, reconnect replay, cancellation conflicts, explicit retry, timeout, evidence persistence, retention, Fleet HTTP authorization, Studio route RBAC, OpenAPI generation, and the complete Backup Operator Go suite.

The disposable Fleet Compose environment was upgraded in place to schema 9. A project-b observe-only operation remained queued with zero attempts across a Fleet Control restart; exact idempotent replay returned that operation; Agent recovery produced task `:1`; explicit retry produced only task `:2`; and a second queued operation cancelled with zero attempts. Both project Agents and Fleet Control were healthy after the drill. No destructive action was run against project-a.
