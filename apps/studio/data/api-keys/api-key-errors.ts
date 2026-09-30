import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'

import { handleError } from '@/data/fetchers'
import { profileKeys } from '@/data/profile/keys'
import { getMfaListFactors } from '@/data/profile/mfa-list-factors-query'
import { BASE_PATH } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'
import { ResponseError } from '@/types'

export class APIKeyAAL2RequiredError extends ResponseError {}

export function handleAPIKeyMutationError(error: unknown): never {
  const parsed = z
    .object({ code: z.union([z.literal('aal2_required'), z.literal(403)]), message: z.string() })
    .safeParse(error)
  if (parsed.success && parsed.data.message.includes('recent AAL2 session'))
    throw new APIKeyAAL2RequiredError(parsed.data.message)
  return handleError(error)
}

export async function showAPIKeyMfaAction(error: ResponseError, queryClient: QueryClient) {
  if (!(error instanceof APIKeyAAL2RequiredError)) return false
  try {
    const factors = await queryClient.fetchQuery({
      queryKey: profileKeys.mfaFactors(),
      queryFn: getMfaListFactors,
    })
    const hasFactor = factors.totp.length > 0
    const query = new URLSearchParams({
      returnTo: window.location.pathname + window.location.search,
      ...(hasFactor ? { reauthenticate: 'true' } : {}),
    })
    const path = hasFactor ? '/sign-in-mfa' : '/account/security'
    toast.error($t('Verify your identity to apply'), {
      duration: 15000,
      action: {
        label: $t(hasFactor ? 'Verify AAL2 again' : 'Set up MFA'),
        onClick: () => window.location.assign(`${BASE_PATH}${path}?${query}`),
      },
    })
  } catch {
    toast.error($t('Verify your identity to apply'), {
      action: {
        label: $t('Set up MFA'),
        onClick: () => window.location.assign(`${BASE_PATH}/account/security`),
      },
    })
  }
  return true
}
