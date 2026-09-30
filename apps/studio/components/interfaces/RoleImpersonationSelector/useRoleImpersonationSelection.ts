import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { getRoleSelectionUpdate, getSelectedRoleOption } from './RoleImpersonationSelector.utils'
import { t as $t } from '@/lib/i18n'
import type { PostgrestRole } from '@/lib/role-impersonation'
import type { RoleImpersonationController } from '@/state/role-impersonation-state'
import type { ResponseError } from '@/types'

export const useRoleImpersonationSelection = (state: RoleImpersonationController) => {
  const [isAuthenticatedPending, setIsAuthenticatedPending] = useState(false)

  useEffect(() => {
    if (
      state.role?.type === 'postgrest' &&
      state.role.role === 'authenticated' &&
      isAuthenticatedPending
    ) {
      setIsAuthenticatedPending(false)
    }
  }, [isAuthenticatedPending, state.role])

  const selectedOption = isAuthenticatedPending
    ? 'authenticated'
    : getSelectedRoleOption(state.role)

  async function onSelectedChange(value: PostgrestRole) {
    const update = getRoleSelectionUpdate(value)
    if (!update.shouldSetRole) {
      setIsAuthenticatedPending(true)
      return
    }

    try {
      await state.setRole(update.role)
      setIsAuthenticatedPending(false)
    } catch (error) {
      toast.error(
        $t('Failed to impersonate user: {{value0}}', { value0: (error as ResponseError).message })
      )
    }
  }

  function keepAuthenticatedSelected() {
    setIsAuthenticatedPending(true)
  }

  return { selectedOption, onSelectedChange, keepAuthenticatedSelected }
}
