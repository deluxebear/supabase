import * as jose from 'jsr:@panva/jose@6'

console.log('main function started')

const MAX_WORKER_RETRIES = 3

const JWT_SECRET = Deno.env.get('JWT_SECRET')
const SUPABASE_JWKS = parseJwks(Deno.env.get('SUPABASE_JWKS'))
const LOCAL_JWKS = SUPABASE_JWKS ? jose.createLocalJWKSet(SUPABASE_JWKS) : null
const VERIFY_JWT = Deno.env.get('VERIFY_JWT') === 'true'
const NO_MODULE_CACHE = Deno.env.get('FUNCTIONS_NO_MODULE_CACHE') === 'true'

type AuthFailure = {
  code: RequestErrors
  message?: string
}

type FunctionFailure = {
  code: RequestErrors
  message: string
  status: number
}

export enum RequestErrors {
  InvalidLegacyJWT = 'UNAUTHORIZED_LEGACY_JWT',
  InvalidAsymmetricJWT = 'UNAUTHORIZED_ASYMMETRIC_JWT',
  InvalidTokenFormat = 'UNAUTHORIZED_INVALID_JWT_FORMAT',
  UnsupportedTokenAlgorithm = 'UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM',
  MissingAuthHeader = 'UNAUTHORIZED_NO_AUTH_HEADER',
  NotFound = 'NOT_FOUND',
  BootError = 'BOOT_ERROR',
  EdgeFunctionError = 'EDGE_FUNCTION_ERROR',
  IdleTimeout = 'IDLE_TIMEOUT',
  WorkerResourceLimit = 'WORKER_RESOURCE_LIMIT',
  WorkerError = 'WORKER_ERROR',
  InvalidResponseStatusCode = 'INVALID_RESPONSE_STATUS_CODE',
}

function getFunctionErrorResponse({ code, message, status }: FunctionFailure): Response {
  return Response.json(
    { code, message },
    {
      status,
      headers: {
        'sb-error-code': code,
        'Access-Control-Expose-Headers': 'sb-error-code',
      },
    }
  )
}

function handleWorkerResponse(response: Response): Response {
  if (response.status < 500) return response

  const headers = new Headers(response.headers)
  headers.set('sb-error-code', RequestErrors.EdgeFunctionError)

  const exposedHeaders = (headers.get('Access-Control-Expose-Headers') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (!exposedHeaders.some((name) => name.toLowerCase() === 'sb-error-code')) {
    exposedHeaders.push('sb-error-code')
  }
  headers.set('Access-Control-Expose-Headers', exposedHeaders.join(', '))

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function resolveRuntimeError(e: unknown): FunctionFailure {
  // These error classes are supplied by Edge Runtime, rather than stock Deno.
  if (e instanceof Deno.errors.InvalidWorkerCreation) {
    return {
      code: RequestErrors.BootError,
      message: 'Function failed to start (please check logs)',
      status: 503,
    }
  }
  if (e instanceof Deno.errors.WorkerRequestCancelled) {
    return {
      code: RequestErrors.WorkerResourceLimit,
      message: 'Function failed due to not having enough compute resources (please check logs)',
      status: 546,
    }
  }
  if (e instanceof Deno.errors.WorkerRequestIdleTimeout) {
    return {
      code: RequestErrors.IdleTimeout,
      message: 'Request idle timeout limit (150s) reached',
      status: 504,
    }
  }
  // No dedicated runtime error class exists for invalid response statuses.
  // The Response constructor throws directly here or inside the user worker.
  if (
    (e instanceof RangeError || e instanceof Deno.errors.InvalidWorkerResponse) &&
    e.message.includes('is not equal to 101 and outside the range [200, 599]')
  ) {
    return {
      code: RequestErrors.InvalidResponseStatusCode,
      message: 'Function returned an invalid HTTP status code (please check logs)',
      status: 500,
    }
  }
  if (
    e instanceof Deno.errors.WorkerAlreadyRetired ||
    e instanceof Deno.errors.InvalidWorkerResponse
  ) {
    return {
      code: RequestErrors.WorkerError,
      message: 'Function exited due to an error (please check logs)',
      status: 500,
    }
  }
  return { code: RequestErrors.EdgeFunctionError, message: 'Internal Server Error', status: 500 }
}

// NOTE:(kallebysantos) We don't check for valid keys but just the bare array parsing,
// let this for 'jose' lib verification
export function parseJwks(raw: string | undefined): jose.JSONWebKeySet | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.keys && Array.isArray(parsed.keys)) {
      return parsed as jose.JSONWebKeySet
    }
    return null
  } catch {
    return null
  }
}

/**
 * Extract JWT token from 'Authorization' header or fallback to 'sb-api-key' compatibility
 *
 * Parses the Authorization header to extract the Bearer token.
 * Expects format: "Bearer <token>"
 *
 * @param req - The HTTP request object
 * @returns The JWT token string or an authentication failure
 */
function extractBearerToken(authHeader: string | null): string | null {
  const tokenParts = (authHeader ?? '').trim().split(/\s+/)
  const [bearer, token] = tokenParts
  if (bearer.toLowerCase() !== 'bearer' || tokenParts.length !== 2 || !token) {
    return null
  }
  return token
}

function getAuthToken(req: Request): string | AuthFailure {
  const authHeader = req.headers.get('authorization')
  const sbApiKeyCompatibilityToken = req.headers.get('sb-api-key')

  if (!authHeader && !sbApiKeyCompatibilityToken) {
    return {
      code: RequestErrors.MissingAuthHeader,
      message: 'Missing authorization header',
    }
  }

  // NOTE:(kallebysantos) Compatibility mode is triggered when all conditions match:
  // - API proxy mints a temp token
  // - Original bearer is not present or is ApiKey
  const bearerToken = extractBearerToken(authHeader)
  const token = !bearerToken || bearerToken.startsWith('sb_')
    ? sbApiKeyCompatibilityToken
    : bearerToken

  if (!token) {
    return {
      code: RequestErrors.InvalidTokenFormat,
      message: 'Invalid JWT format',
    }
  }

  return token
}

function getAuthErrorResponse({ code, message = 'Invalid JWT' }: AuthFailure) {
  return Response.json(
    {
      code,
      message,
      // DEPRECATED: Retained for backward compatibility.
      msg: message,
    },
    {
      status: 401,
      headers: {
        'sb-error-code': code,
        'Access-Control-Expose-Headers': 'sb-error-code',
      },
    }
  )
}

async function isValidLegacyJWT(jwt: string): Promise<AuthFailure | null> {
  if (!JWT_SECRET) {
    console.error('JWT_SECRET not available for HS256 token verification')
    return { code: RequestErrors.InvalidLegacyJWT }
  }

  const encoder = new TextEncoder();
  const secretKey = encoder.encode(JWT_SECRET);

  try {
    await jose.jwtVerify(jwt, secretKey);
  } catch (e) {
    console.error('Symmetric Legacy JWT verification error', e);
    return { code: RequestErrors.InvalidLegacyJWT }
  }
  return null
}

async function isValidJWT(jwt: string): Promise<AuthFailure | null> {
  if (!LOCAL_JWKS) {
    console.error('JWKS not available for ES256/RS256 token verification')
    return { code: RequestErrors.InvalidAsymmetricJWT }
  }

  try {
    await jose.jwtVerify(jwt, LOCAL_JWKS);
  } catch (e) {
    console.error('Asymmetric JWT verification error', e);
    return { code: RequestErrors.InvalidAsymmetricJWT }
  }

  return null
}

/**
 * Verify JWT token, handling both legacy (HS256) and newer (ES256/RS256) algorithms
 * 
 * This function automatically detects the algorithm used in the token and applies
 * the appropriate verification method:
 * - HS256: Uses JWT_SECRET (symmetric key)
 * - ES256/RS256: Uses JWKS endpoint (asymmetric public keys)
 * 
 * This fix ensures compatibility with both legacy tokens and newer asymmetric tokens,
 * resolving the "Key for the ES256 algorithm must be of type CryptoKey" error.
 * 
 * @param jwt - The JWT token string to verify
 * @returns Authentication failure details, or null when verification succeeds
 */
async function isValidHybridJWT(jwt: string): Promise<AuthFailure | null> {
  let jwtAlgorithm: string | undefined
  try {
    jwtAlgorithm = jose.decodeProtectedHeader(jwt).alg
  } catch (e) {
    console.error('JWT format error', e)
    return {
      code: RequestErrors.InvalidTokenFormat,
      message: 'Invalid JWT format',
    }
  }

  if (!jwtAlgorithm) {
    return {
      code: RequestErrors.InvalidTokenFormat,
      message: 'Invalid JWT format',
    }
  }

  if (jwtAlgorithm === 'HS256') {
    console.log(`Legacy token type detected, attempting ${jwtAlgorithm} verification.`)

    return await isValidLegacyJWT(jwt)
  }

  if (jwtAlgorithm === 'ES256' || jwtAlgorithm === 'RS256') {
    return await isValidJWT(jwt)
  }

  return {
    code: RequestErrors.UnsupportedTokenAlgorithm,
    message: `Unsupported JWT algorithm ${jwtAlgorithm}`,
  }
}

async function shouldVerifyJWT(serviceName: string | undefined): Promise<boolean> {
  if (!serviceName || serviceName === '__fleet_probe') return VERIFY_JWT
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(serviceName)) return VERIFY_JWT

  const runtimePath = `/home/deno/functions/${serviceName}`
  let revision: string
  try {
    revision = (await Deno.readTextFile(`${runtimePath}/.fleet-runtime-revision`)).trim()
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return VERIFY_JWT
    throw error
  }
  if (!/^[0-9a-f]{64}$/.test(revision)) {
    throw new Error('Fleet function runtime revision is invalid')
  }

  let setting: string
  try {
    setting = (await Deno.readTextFile(`${runtimePath}/.fleet-runtime-verify-jwt`)).trim()
  } catch (error) {
    // Existing Fleet deployments predate per-function settings.
    if (error instanceof Deno.errors.NotFound) return VERIFY_JWT
    throw error
  }
  if (setting === 'true') return true
  if (setting === 'false') return false
  throw new Error('Fleet function runtime JWT setting is invalid')
}

async function handleRequest(req: Request, invocation: { execution_id?: string }) {
  const url = new URL(req.url)
  const { pathname } = url
  const path_parts = pathname.split('/')
  const service_name = path_parts[1]

  let verifyJWT: boolean
  try {
    verifyJWT = await shouldVerifyJWT(service_name)
  } catch (error) {
    console.error(error)
    return Response.json({ msg: 'Function runtime configuration is invalid' }, { status: 500 })
  }

  if (req.method !== 'OPTIONS' && verifyJWT) {
    try {
      const token = getAuthToken(req)
      if (typeof token !== 'string') {
        return getAuthErrorResponse(token)
      }
      const authFailure = await isValidHybridJWT(token)
      if (authFailure) {
        return getAuthErrorResponse(authFailure)
      }
    } catch (e) {
      console.error(e)
      return getAuthErrorResponse({
        code: RequestErrors.InvalidTokenFormat,
        message: 'Invalid JWT format',
      })
    }
  }

  // Fleet checks the active revision without invoking user code. A function may
  // accept only POST requests or require a request body, so its handler is not
  // a reliable deployment probe.
  if (service_name === '__fleet_probe') {
    const slug = path_parts[2]
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (
      req.method !== 'GET' ||
      !slug ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(slug) ||
      !serviceKey ||
      req.headers.get('authorization') !== `Bearer ${serviceKey}`
    ) {
      return new Response(null, { status: 404 })
    }
    try {
      const revision = (await Deno.readTextFile(
        `/home/deno/functions/${slug}/.fleet-runtime-revision`
      )).trim()
      if (/^[0-9a-f]{64}$/.test(revision)) {
        await Deno.stat(`/home/deno/functions/.fleet-artifacts/${slug}/revisions/${revision}`)
        return new Response(null, {
          status: 204,
          headers: { 'X-Supabase-Fleet-Revision': revision, 'Cache-Control': 'no-store' },
        })
      }
    } catch {
      // A missing revision marker or artifact means the function is absent.
    }
    return new Response(null, { status: 404 })
  }

  if (!service_name || service_name === '') {
    return getFunctionErrorResponse({
      code: RequestErrors.NotFound,
      message: 'Requested function was not found',
      status: 404,
    })
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(service_name)) {
    return new Response(JSON.stringify({ msg: 'invalid function name' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let servicePath = `/home/deno/functions/${service_name}`
  let fleetRevision: string | undefined
  try {
    const revision = (await Deno.readTextFile(`${servicePath}/.fleet-runtime-revision`)).trim()
    if (/^[0-9a-f]{64}$/.test(revision)) {
      fleetRevision = revision
      servicePath = `/home/deno/functions/.fleet-artifacts/${service_name}/revisions/${revision}`
    }
  } catch {
    // User-managed functions do not have a Fleet revision marker.
  }
  console.error(`serving the request with ${servicePath}`)

  try {
    const serviceInfo = await Deno.stat(servicePath)
    if (!serviceInfo.isDirectory) {
      return getFunctionErrorResponse({
        code: RequestErrors.NotFound,
        message: 'Requested function was not found',
        status: 404,
      })
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return getFunctionErrorResponse({
        code: RequestErrors.NotFound,
        message: 'Requested function was not found',
        status: 404,
      })
    }
    console.error(e)
    return getFunctionErrorResponse({
      code: RequestErrors.BootError,
      message: 'Function failed to start (please check logs)',
      status: 503,
    })
  }

  const memoryLimitMb = 150
  // Keep the wall clock above the 150s request idle timeout configured in Compose.
  const workerTimeoutMs = 400_000
  const requestAbsentTimeoutMs = 60_000
  const noModuleCache = NO_MODULE_CACHE
  // Fleet revisions resolve their own dependencies without a shared import map.
  const importMapPath = null
  // SUPABASE_FUNCTION_SLUG is listed after the container env snapshot so
  // nothing in it can shadow the value, and it is per-request because only this
  // worker knows which function the request resolved to.
  const envVarsObj = { ...Deno.env.toObject(), SUPABASE_FUNCTION_SLUG: service_name }
  const envVars = Object.keys(envVarsObj).map((k) => [k, envVarsObj[k]])

  const callWorker = async (req: Request, retriesLeft = MAX_WORKER_RETRIES): Promise<Response> => {
    // Preserve the body before fetch() can consume it, even on a failed attempt.
    // Must run before `new Request(req)` below, which takes over the body.
    // The unread retry branch can buffer the entire body in main-worker memory,
    // even when the first attempt succeeds.
    const retryReq = retriesLeft > 0 ? req.clone() : null

    try {
      const worker = await EdgeRuntime.userWorkers.create({
        servicePath,
        memoryLimitMb,
        workerTimeoutMs,
        context: { supervisor: { requestAbsentTimeoutMs } },
        noModuleCache,
        importMapPath,
        envVars,
      })
      invocation.execution_id = worker.key
      // Gateway-minted internal JWT is for this router only; never expose it to user functions.
      const userReq = new Request(req)
      userReq.headers.delete('sb-api-key')
      EdgeRuntime.applySupabaseTag(req, userReq)
      const workerResponse = handleWorkerResponse(await worker.fetch(userReq))
      if (fleetRevision === undefined) return workerResponse
      const headers = new Headers(workerResponse.headers)
      headers.set('X-Supabase-Fleet-Revision', fleetRevision)
      return new Response(workerResponse.body, {
        status: workerResponse.status,
        statusText: workerResponse.statusText,
        headers,
      })
    } catch (e) {
      // Retirement rejects before dispatch, so user code has not run yet.
      if (e instanceof Deno.errors.WorkerAlreadyRetired && retryReq) {
        console.warn(`${service_name}: worker retired before dispatch; retrying (${retriesLeft} left)`)
        // Request.clone() does not copy the tag that connects streaming to the client.
        EdgeRuntime.applySupabaseTag(req, retryReq)
        return await callWorker(retryReq, retriesLeft - 1)
      }

      console.error(e)
      return getFunctionErrorResponse(resolveRuntimeError(e))
    }
  }

  return await callWorker(req)
}

Deno.serve(async (req: Request) => {
  const slug = new URL(req.url).pathname.split('/')[1]
  const started = performance.now()
  const invocation: { execution_id?: string } = {}
  const response = await handleRequest(req, invocation)
  if (slug && /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(slug) && slug !== '__fleet_probe') {
    const executionTime = Math.round((performance.now() - started) * 1000) / 1000
    console.log(JSON.stringify({
      log_type: 'FunctionInvocation',
      timestamp: new Date().toISOString(),
      event_message: [req.method, response.status, `/functions/v1/${slug}`, executionTime, invocation.execution_id ?? ''].join(' | '),
      metadata: {
        function_id: `${Deno.env.get('FUNCTIONS_PROJECT_REF') ?? 'default'}:${slug}`,
        execution_id: invocation.execution_id,
        execution_time_ms: executionTime,
        event_type: 'Invocation',
        level: 'info',
        request: { method: req.method, pathname: `/functions/v1/${slug}` },
        response: { status_code: response.status },
      },
    }))
  }
  return response
})
