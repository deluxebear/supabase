import * as jose from 'jsr:@panva/jose@6'

console.log('main function started')

const JWT_SECRET = Deno.env.get('JWT_SECRET')
const SUPABASE_JWKS = parseJwks(Deno.env.get('SUPABASE_JWKS'))
const LOCAL_JWKS = SUPABASE_JWKS ? jose.createLocalJWKSet(SUPABASE_JWKS) : null
const VERIFY_JWT = Deno.env.get('VERIFY_JWT') === 'true'
const NO_MODULE_CACHE = Deno.env.get('FUNCTIONS_NO_MODULE_CACHE') === 'true'

type AuthFailure = {
  code: RequestErrors
  message?: string
}

export enum RequestErrors {
  InvalidLegacyJWT = 'UNAUTHORIZED_LEGACY_JWT',
  InvalidAsymmetricJWT = 'UNAUTHORIZED_ASYMMETRIC_JWT',
  InvalidTokenFormat = 'UNAUTHORIZED_INVALID_JWT_FORMAT',
  UnsupportedTokenAlgorithm = 'UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM',
  MissingAuthHeader = 'UNAUTHORIZED_NO_AUTH_HEADER',
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
 * Extract JWT token from Authorization header
 *
 * Parses the Authorization header to extract the Bearer token.
 * Expects format: "Bearer <token>"
 *
 * @param req - The HTTP request object
 * @returns The JWT token string or an authentication failure
 */
function getAuthToken(req: Request): string | AuthFailure {
  const authHeader = req.headers.get('authorization')
  if (!authHeader) {
    return {
      code: RequestErrors.MissingAuthHeader,
      message: 'Missing authorization header',
    }
  }
  const tokenParts = authHeader.trim().split(/\s+/)
  const [bearer, token] = tokenParts
  if (bearer.toLowerCase() !== 'bearer' || tokenParts.length !== 2 || !token) {
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

Deno.serve(async (req: Request) => {
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
    const error = { msg: 'missing function name in request' }
    return new Response(JSON.stringify(error), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
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

  const memoryLimitMb = 150
  const workerTimeoutMs = 1 * 60 * 1000
  const noModuleCache = NO_MODULE_CACHE
  const importMapPath = null
  // SUPABASE_FUNCTION_SLUG is listed after the container env snapshot so
  // nothing in it can shadow the value, and it is per-request because only this
  // worker knows which function the request resolved to.
  const envVarsObj = { ...Deno.env.toObject(), SUPABASE_FUNCTION_SLUG: service_name }
  const envVars = Object.keys(envVarsObj).map((k) => [k, envVarsObj[k]])

  try {
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb,
      workerTimeoutMs,
      noModuleCache,
      importMapPath,
      envVars,
    })
    const workerResponse = await worker.fetch(req)
    if (fleetRevision === undefined) return workerResponse
    const headers = new Headers(workerResponse.headers)
    headers.set('X-Supabase-Fleet-Revision', fleetRevision)
    return new Response(workerResponse.body, {
      status: workerResponse.status,
      statusText: workerResponse.statusText,
      headers,
    })
  } catch (e) {
    const error = { msg: e.toString() }
    return new Response(JSON.stringify(error), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
