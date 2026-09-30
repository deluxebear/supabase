import type { SafeSqlFragment } from '@supabase/pg-meta'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'

import { pgDurableKeys } from './keys'
import { executeSql } from '@/data/sql/execute-sql-mutation'
import { t as $t } from '@/lib/i18n'
import type { ResponseError, UseCustomMutationOptions } from '@/types'

export type PgDurableMutationVariables = {
  projectRef: string
  connectionString?: string | null
  sql: SafeSqlFragment
}
async function executeDurableAction(variables: PgDurableMutationVariables) {
  const { result } = await executeSql<unknown>(variables)
  return z
    .array(z.object({ value: z.string() }))
    .nonempty()
    .parse(result)[0].value
}
export type PgDurableMutationData = Awaited<ReturnType<typeof executeDurableAction>>

export const usePgDurableMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<PgDurableMutationData, ResponseError, PgDurableMutationVariables>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: executeDurableAction,
    async onSuccess(data, variables, context) {
      await queryClient.invalidateQueries({ queryKey: pgDurableKeys.all(variables.projectRef) })
      await onSuccess?.(data, variables, context)
    },
    async onError(error: ResponseError, variables, context) {
      if (onError) await onError(error, variables, context)
      else toast.error($t('Failed to update workflow: {{message}}', { message: error.message }))
    },
    ...options,
  })
}
