import { createClient } from '@supabase/supabase-js'

import { getAPIKeys, getKeys } from '@/data/api-keys/api-keys-query'
import { getOrRefreshTemporaryApiKey } from '@/data/api-keys/temp-api-keys-utils'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

/**
 * [self-platform] The project gateway accepts only the project's static API
 * keys in the `apikey` header, so the minted temporary JWT is rejected there
 * with a plain-text 401. Send a public key as `apikey` and the temporary JWT as
 * the bearer token, which is what Auth checks for admin access.
 */
async function getGatewayApiKey(projectRef: string) {
  const { publishableKey, anonKey } = getKeys(await getAPIKeys({ projectRef }))
  const gatewayApiKey = publishableKey?.api_key ?? anonKey?.api_key
  if (!gatewayApiKey) throw new Error('No publishable or anon API key found for this project')
  return gatewayApiKey
}

/**
 * Creates a Supabase client bound to a specific project. It uses temporary API key.
 */
export async function createProjectSupabaseClient(projectRef: string, clientEndpoint: string) {
  try {
    const { apiKey } = await getOrRefreshTemporaryApiKey(projectRef)
    const gatewayApiKey = IS_SELF_PLATFORM ? await getGatewayApiKey(projectRef) : undefined

    return createClient(clientEndpoint, gatewayApiKey ?? apiKey, {
      ...(gatewayApiKey && { global: { headers: { Authorization: `Bearer ${apiKey}` } } }),
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storage: {
          getItem: (_key) => {
            return null
          },
          setItem: (_key, _value) => {},
          removeItem: (_key) => {},
        },
      },
    })
  } catch (error) {
    throw error
  }
}
