import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { ModuleKind, transpileModule } from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const revision = 'a'.repeat(64)
const source = readFileSync(
  resolve(__dirname, '../../../../docker/volumes/functions/main/index.ts'),
  'utf8'
)
const compiled = transpileModule(source.replace(/^import \* as jose .*$/m, ''), {
  compilerOptions: { module: ModuleKind.CommonJS },
}).outputText

function loadRuntime({ fleet = false, verifyJWT = false } = {}) {
  let handler: (request: Request) => Promise<Response>
  const logs = vi.fn()
  const workerFetch = vi.fn(async (_request: Request) => new Response('ok'))
  const create = vi.fn(async (_options: unknown) => ({ key: 'execution-1', fetch: workerFetch }))
  class NotFound extends Error {}
  class WorkerAlreadyRetired extends Error {}
  class WorkerRequestIdleTimeout extends Error {}
  const env: Record<string, string> = {
    VERIFY_JWT: String(verifyJWT),
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    FUNCTIONS_PROJECT_REF: 'project-1',
  }
  const readTextFile = vi.fn(async (path: string) => {
    if (fleet && path.endsWith('/.fleet-runtime-revision')) return revision
    if (fleet && path.endsWith('/.fleet-runtime-verify-jwt')) return 'false'
    throw new NotFound('No runtime marker')
  })
  runInNewContext(compiled, {
    exports: {},
    jose: {},
    Request,
    Response,
    Headers,
    URL,
    performance,
    console: { log: logs, error: vi.fn(), warn: vi.fn() },
    Deno: {
      serve: (callback: typeof handler) => {
        handler = callback
      },
      env: { get: (key: string) => env[key], toObject: () => env },
      readTextFile,
      stat: vi.fn(async () => ({ isDirectory: true })),
      errors: {
        WorkerAlreadyRetired,
        WorkerRequestIdleTimeout,
        NotFound,
        InvalidWorkerCreation: class extends Error {},
        WorkerRequestCancelled: class extends Error {},
        InvalidWorkerResponse: class extends Error {},
      },
    },
    EdgeRuntime: { userWorkers: { create }, applySupabaseTag: vi.fn() },
  })
  return {
    invoke: (req: Request) => handler(req),
    create,
    workerFetch,
    logs,
    WorkerAlreadyRetired,
    WorkerRequestIdleTimeout,
  }
}

describe('Fleet functions runtime upstream integration', () => {
  it('keeps Fleet revisions, invocation logs and per-function JWT overrides', async () => {
    const runtime = loadRuntime({ fleet: true, verifyJWT: true })
    const response = await runtime.invoke(new Request('http://functions/example'))
    expect(response.status).toBe(200)
    expect(response.headers.get('X-Supabase-Fleet-Revision')).toBe(revision)
    expect(runtime.create).toHaveBeenCalledWith(
      expect.objectContaining({
        servicePath: `/home/deno/functions/.fleet-artifacts/example/revisions/${revision}`,
        importMapPath: null,
      })
    )
    const invocation = runtime.logs.mock.calls
      .map(([value]) => value)
      .find((value) => value.startsWith('{'))
    expect(JSON.parse(invocation).metadata.execution_id).toBe('execution-1')
  })

  it('retries retired workers with the request body and strips the gateway token', async () => {
    const runtime = loadRuntime()
    runtime.workerFetch.mockRejectedValueOnce(new runtime.WorkerAlreadyRetired())
    runtime.workerFetch.mockImplementationOnce(async (request) => {
      expect(await request.text()).toBe('payload')
      expect(request.headers.get('sb-api-key')).toBeNull()
      expect(request.headers.get('authorization')).toBe('Bearer user-jwt')
      return new Response('retried')
    })
    const response = await runtime.invoke(
      new Request('http://functions/example', {
        method: 'POST',
        body: 'payload',
        headers: { 'sb-api-key': 'internal-jwt', authorization: 'Bearer user-jwt' },
      })
    )
    expect(await response.text()).toBe('retried')
    expect(runtime.create).toHaveBeenCalledTimes(2)
  })

  it('stops after three retries and returns the upstream error code', async () => {
    const runtime = loadRuntime()
    runtime.create.mockRejectedValue(new runtime.WorkerAlreadyRetired())
    const response = await runtime.invoke(new Request('http://functions/example'))
    expect(runtime.create).toHaveBeenCalledTimes(4)
    expect(response.status).toBe(500)
    expect(response.headers.get('sb-error-code')).toBe('WORKER_ERROR')
  })

  it('reports timeouts without retrying user code', async () => {
    const runtime = loadRuntime()
    runtime.workerFetch.mockRejectedValue(new runtime.WorkerRequestIdleTimeout())
    const response = await runtime.invoke(new Request('http://functions/example'))
    expect(runtime.create).toHaveBeenCalledOnce()
    expect(response.status).toBe(504)
    expect(response.headers.get('sb-error-code')).toBe('IDLE_TIMEOUT')
  })

  it('probes Fleet revisions without invoking a worker', async () => {
    const runtime = loadRuntime({ fleet: true })
    const response = await runtime.invoke(
      new Request('http://functions/__fleet_probe/example', {
        headers: { authorization: 'Bearer service-key' },
      })
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('X-Supabase-Fleet-Revision')).toBe(revision)
    expect(runtime.create).not.toHaveBeenCalled()
  })
})
