import { createClient, SupabaseClient } from '@supabase/supabase-js'

import { resolveProjectConnection } from '@/lib/api/self-platform/resolve-connection'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

// Lazy admin client for self-hosted API routes under
// `pages/api/platform/{auth,storage}/**`. SUPABASE_URL and
// SUPABASE_SERVICE_KEY are only set on self-hosted deployments — the
// platform build doesn't need these env vars. But on the TanStack Start
// server, every API route's module gets evaluated when the single function
// handler loads, regardless of whether its URL is hit. Without a lazy
// wrapper, constructing the client at module scope with undefined
// credentials would crash every request on platform.
//
// Proxy defers client construction until a property is actually accessed,
// which only happens inside the handler (i.e. on self-hosted where the env
// vars are set).
let _client: SupabaseClient | undefined

export const selfHostedSupabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    _client ??= createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
    return Reflect.get(_client, prop)
  },
})

// [self-platform] Per-ref admin client. Registry-resolved projects get their
// own kong URL + service key; plain self-hosted and the unregistered-default
// fallback keep the historical global client above. Clients are created per
// call (cheap) — no cache, so registry row updates take effect immediately.
export interface AdminContext {
  client: SupabaseClient
  // Client-reachable base URL for rewriting service-internal URLs in
  // responses (storage signed/public URLs). Registry kong_url is the
  // browser-facing gateway by registration contract.
  publicBaseUrl: string
}

export async function getAdminContextForRef(
  ref: string | string[] | undefined
): Promise<AdminContext> {
  if (IS_SELF_PLATFORM) {
    const conn = await resolveProjectConnection(String(ref))
    if (conn.row) {
      return {
        client: createClient(conn.supabaseUrl, conn.serviceKey),
        publicBaseUrl: conn.supabaseUrl,
      }
    }
  }
  return {
    client: selfHostedSupabaseAdmin,
    publicBaseUrl: process.env.SUPABASE_PUBLIC_URL ?? '',
  }
}

export async function getAdminClientForRef(
  ref: string | string[] | undefined
): Promise<SupabaseClient> {
  return (await getAdminContextForRef(ref)).client
}
