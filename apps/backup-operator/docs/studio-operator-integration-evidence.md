# Studio to Backup Operator integration evidence

Validated with a real `cmd/backup-operator` process and an isolated SQLite control store. Run:

```bash
./scripts/verify-studio-operator-integration.sh
```

The harness fails when authentication is bypassed or a Studio cluster route is not registered.

## Verified

- The real Operator starts, reports healthy, and persists an operation.
- Missing and invalid service assertions return HTTP 401; a correctly signed assertion with the pinned issuer and audience is accepted.
- Cluster access is checked against the assertion's project and scope grants.
- Typed operation create/read/cancel requests work over HTTP.
- SSE returns cursor `1`; reconnecting with `Last-Event-ID: 1` returns only cursor `2` and `job_cancelled`.
- The cluster policy, backup manifest, job, restore plan, confirm, execute, and rollback paths are registered. Policy/job reads use control-store records. Restore planning fails closed with HTTP 409 while runtime safety evidence is unavailable.
- The Studio proxy unit suite verifies its fixed allowlist, project RBAC, destructive AAL2 gate, and typed upstream error mapping.
- Studio React Query and component suites exercise proxy URLs through MSW for policy, backups, restore plan, confirm, execute, job polling, manual intervention, and rollback.

## Real Operator results

| Check | Current result | Required result |
| --- | --- | --- |
| Create operation without service assertion | HTTP 401 | HTTP 401 |
| Create operation with a valid assertion | HTTP 201 | HTTP 201 |
| Read operation with an invalid assertion | HTTP 401 | HTTP 401 |
| `PUT /v1/clusters/{id}/backup-policy` without a registered repository | HTTP 400 | Fail closed; route registered |
| `GET /v1/clusters/{id}/jobs/{job}` | HTTP 200 | Typed job response |
| `POST /v1/clusters/{id}/restore-plans` without safety evidence | HTTP 409 | Fail closed; route registered |

The harness does not manufacture a policy repository, backup/WAL coverage, topology observation, capacity observation, or restore outcome. Consequently it proves authentication, routing, durable job lookup, SSE replay, and fail-closed recovery behavior, but not a successful destructive recovery. AAL2 confirmation and execution require a durable restore plan produced from those observations.

## Browser E2E status

`e2e/studio/features/backup-operator.spec.ts` exercises the rendered Studio route through its real browser UI and fixed network boundary. It covers an AAL2 rejection and upgrade affordance, manual-intervention diagnostics with rollback, and an orphaned non-takeover state that cannot be rolled back automatically. These browser tests complement, but do not replace, the real Operator integration harness above: the browser network fixture is typed and deterministic, while the harness proves service assertions, durable state, SSE replay, and fail-closed behavior against a real process.

Run the feature-gated browser suite with:

```bash
NEXT_PUBLIC_SELF_PLATFORM=true pnpm --prefix e2e/studio run e2e -- features/backup-operator.spec.ts
```

The destructive PostgreSQL/pgBackRest path is proven separately by the Compose, Systemd, Kubernetes, Patroni, and CNPG evidence runs. No test claims that a browser fixture itself provisions PostgreSQL or repository credentials.
