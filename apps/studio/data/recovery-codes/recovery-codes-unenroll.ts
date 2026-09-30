import type { AuthMFAUnenrollResponse } from '@supabase/auth-js'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { recoveryCodeKeys } from './keys'
import { captureCriticalError } from '@/lib/error-reporting'
import { auth } from '@/lib/gotrue'
import { t as $t } from '@/lib/i18n'
import { UseCustomMutationOptions } from '@/types'

export const recoveryCodesUnenroll = async () => {
  const { error, data } = await auth.mfa.recoveryCodes.unenroll()
  if (error) throw error
  return data
}

type RecoveryCodesUnenrollResponse = AuthMFAUnenrollResponse['data']
type RecoveryCodesUnenrollError = NonNullable<AuthMFAUnenrollResponse['error']>

export const useRecoveryCodesUnenrollMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<RecoveryCodesUnenrollResponse, RecoveryCodesUnenrollError>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => {
      return recoveryCodesUnenroll()
    },
    async onSuccess(data, variables, context) {
      await queryClient.invalidateQueries({ queryKey: recoveryCodeKeys.status() })

      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error($t('Failed to unenroll recovery codes: {{value0}}', { value0: data.message }))
      } else {
        onError(data, variables, context)
      }
      captureCriticalError(data, 'recovery codes unenroll')
    },
    ...options,
  })
}
