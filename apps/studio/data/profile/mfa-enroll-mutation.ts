import type { AuthMFAEnrollResponse, MFAEnrollParams } from '@supabase/supabase-js'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'

import { auth } from '@/lib/gotrue'
import { t as $t } from '@/lib/i18n'
import { UseCustomMutationOptions } from '@/types'

const mfaEnroll = async (params: MFAEnrollParams) => {
  const { error, data } = await auth.mfa.enroll(params)

  if (error) throw error
  return data
}

type CustomMFAEnrollResponse = NonNullable<AuthMFAEnrollResponse['data']>
type CustomMFAEnrollError = NonNullable<AuthMFAEnrollResponse['error']>

export const useMfaEnrollMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<CustomMFAEnrollResponse, CustomMFAEnrollError, MFAEnrollParams>,
  'mutationFn'
> = {}) => {
  return useMutation({
    mutationFn: (vars) => mfaEnroll(vars),
    async onSuccess(data, variables, context) {
      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error($t('Failed to enroll factor: {{value0}}', { value0: data.message }))
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
