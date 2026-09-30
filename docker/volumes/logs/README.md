# Edge Function metrics

The Compose functions service starts Edge Runtime with the main service and an
event worker at `/home/deno/functions/.events`. The main service emits one
invocation record with `execution_time_ms` and the worker's `execution_id`.
The event worker forwards Boot, Log, UncaughtException, and Shutdown events.

`execution_time_ms` measures elapsed time from entering the main request handler
until the user worker returns response headers. It includes authentication and
worker startup. It does not measure consumption of a streaming response body.

CPU time comes from `Shutdown.cpu_time_used`. Memory comes from the
`Shutdown.memory_used` total, heap, and external snapshots. These are worker
lifetime metrics, not independent per-request measurements or peak memory.
Multiple invocations can share the same `execution_id`. Worker pool policy and
resource limits are unchanged. CPU and memory appear after the worker exits.

The `function-logs-init` Compose service requires Logflare 1.50 or later. It
discovers or creates dedicated `function_edge_logs` and `function_logs` sources,
initializes new sources, and writes Vector configuration using their UUIDs.
Creation is idempotent, including recovery when Logflare saves a source but its
response serializer fails. Dedicated sources avoid the JSON projections in the
legacy seeded endpoint. Existing legacy sources are retained.

Vector ingests one invocation signal from the main worker, rather than counting
the same request again from Kong. Requests rejected by Kong before reaching the
main service remain gateway logs. The runtime envelope retains Cloud field names
and adds fixed message positions for PG-backed Logflare queries. Studio restores
the structured fields when showing log details, converts memory bytes to MiB,
and weights overview averages by actual sample counts. Older records without
these metrics remain unmeasured.

After updating the main service or event worker, recreate the functions service.
Fleet's init service copies both into existing project volumes. After updating
Vector configuration, rerun `function-logs-init` and recreate Vector so it reads
the generated configuration. Each Vector only ingests its Compose project's logs.

## Unified logs

The same initialization service provisions a dedicated `unified_logs` source.
Vector forwards gateway, Postgres, PostgREST, Auth, Storage, Realtime, Supavisor,
and function invocation events with a flat envelope. Original messages and
metadata are retained in the JSON payload. Function requests are counted once.

Studio keeps the Cloud list, filters, live mode, download, and detail panel.
Self-hosted queries use Logflare's native PostgreSQL management query API through
the server-side project connection and existing Analytics read permission.
The private access token never goes to the browser. Every generated query has
UTC time bounds and a row limit. Cloud keeps its existing endpoint and dialect.

Unified logs begin collecting after Vector is updated. Historical service logs
remain in their existing sources and are accessible in the Logs Explorer;
they are not automatically copied to the unified source. Fields supplied by
Cloud-only infrastructure, such as Cloudflare location, remain absent.
