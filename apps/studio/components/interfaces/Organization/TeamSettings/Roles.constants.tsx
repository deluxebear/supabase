import type { ReactNode } from 'react'

import { t as $t } from '@/lib/i18n'

// Built at render time (not as a module-level constant) so the descriptions
// follow the current UI language.
export function getRoleDescription(roleName: string | undefined): ReactNode | undefined {
  switch (roleName) {
    case 'Owner':
      return (
        <>
          {$t('Full access, including')} <strong>{$t('removing you or any other owner')}</strong>,{' '}
          <strong>{$t('deleting the organization')}</strong>
          {$t(', and transferring or deleting projects.')}
        </>
      )
    case 'Administrator':
      return (
        <>
          {$t('Manage members, billing, and project settings, including')}{' '}
          <strong>{$t('removing members')}</strong> {$t('and')}{' '}
          <strong>{$t('deleting projects')}</strong>
          {$t('. Cannot manage organization settings or owners.')}
        </>
      )
    case 'Developer':
      return $t(
        'Manage project content, including deleting data, users, files, and Edge Functions. Cannot change settings or delete projects.'
      )
    case 'Read-only':
      return $t(
        'View resources without modifying or deleting them. SQL Editor access is limited to SELECT queries.'
      )
    default:
      return undefined
  }
}
