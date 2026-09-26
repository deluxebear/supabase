import { getAnchor } from 'ui'

import { EdgeFunction } from '@/data/edge-functions/edge-function-query'
import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

export const generateCLICommands = ({
  selectedFunction,
  functionUrl,
  anonKey,
}: {
  selectedFunction?: EdgeFunction
  functionUrl: string
  anonKey: string
}) => {
  const managementCommands: any = [
    {
      command: `supabase functions deploy ${selectedFunction?.slug}`,
      description: 'This will overwrite the deployed function with your new function',
      jsx: () => {
        return (
          <>
            <span className="text-primary">supabase</span> {$t('functions deploy')}{' '}
            {selectedFunction?.slug}
          </>
        )
      },
      comment: 'Deploy a new version',
    },
    {
      command: `supabase functions delete ${selectedFunction?.slug}`,
      description: 'This will remove the function and all the logs associated with it',
      jsx: () => {
        return (
          <>
            <span className="text-primary">supabase</span> {$t('functions delete')}{' '}
            {selectedFunction?.slug}
          </>
        )
      },
      comment: 'Delete the function',
    },
  ]

  const secretCommands: any = [
    {
      command: `supabase secrets list`,
      description: 'This will list all the secrets for your project',
      jsx: () => {
        return (
          <>
            <span className="text-primary">supabase</span> {$t('secrets list')}
          </>
        )
      },
      comment: 'View all secrets',
    },
    {
      command: `supabase secrets set NAME1=VALUE1 NAME2=VALUE2`,
      description: 'This will set secrets for your project',
      jsx: () => {
        return (
          <>
            <span className="text-primary">supabase</span>{' '}
            {$t('secrets set NAME1=VALUE1 NAME2=VALUE2')}
          </>
        )
      },
      comment: 'Set secrets for your project',
    },
    {
      command: `supabase secrets unset NAME1 NAME2 `,
      description: 'This will delete secrets for your project',
      jsx: () => {
        return (
          <>
            <span className="text-primary">supabase</span> {$t('secrets unset NAME1 NAME2')}
          </>
        )
      },
      comment: 'Unset secrets for your project',
    },
  ]

  const invokeCommands: any = [
    {
      command: `curl -L -X POST '${functionUrl}' -H 'Authorization: Bearer ${
        anonKey ?? '[YOUR ANON KEY]'
      }' --data '{"name":"Functions"}'`,
      description: 'Invokes the hello function',
      jsx: () => {
        return (
          <>
            <span className="text-primary">curl</span> {$t("-L -X POST '")}
            {functionUrl}'{' '}
            {selectedFunction?.verify_jwt
              ? `-H
            'Authorization: Bearer [YOUR ANON KEY]' `
              : ''}
            {`--data '{"name":"Functions"}'`}
          </>
        )
      },
      comment: 'Invoke your function',
    },
  ]

  return { managementCommands, secretCommands, invokeCommands }
}

export const getEdgeFunctionErrorDocs = (headers: Record<string, string | string[]>) => {
  const header = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'sb-error-code'
  )?.[1]
  const code = (Array.isArray(header) ? header[0] : header)?.trim()
  const anchor = code ? getAnchor(code) : undefined

  if (!code || !anchor) return undefined

  return {
    code,
    href: `${DOCS_URL}/guides/functions/error-codes#${anchor}`,
  }
}
