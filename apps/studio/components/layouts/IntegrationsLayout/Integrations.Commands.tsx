import { useParams } from 'common'
import type { CommandOptions } from 'ui-patterns/CommandMenu'
import { useRegisterCommands } from 'ui-patterns/CommandMenu'

import { COMMAND_MENU_SECTIONS } from '@/components/interfaces/App/CommandMenu/CommandMenu.utils'
import { orderCommandSectionsByPriority } from '@/components/interfaces/App/CommandMenu/ordering'
import {
  IntegrationDefinition,
  INTEGRATIONS,
} from '@/components/interfaces/Integrations/Landing/Integrations.constants'
import { useIsFeatureEnabled } from '@/hooks/misc/useIsFeatureEnabled'
import { t as $t } from '@/lib/i18n'

export function useIntegrationsGotoCommands(options?: CommandOptions) {
  let { ref } = useParams()
  ref ||= '_'

  const { integrationsWrappers } = useIsFeatureEnabled(['integrations:wrappers'])

  const allIntegrations = integrationsWrappers
    ? INTEGRATIONS
    : INTEGRATIONS.filter((x) => !x.id.endsWith('_wrapper'))

  const getName = (integration: IntegrationDefinition) => {
    switch (integration.id) {
      case 'cron':
        return $t('View and manage your Cron Jobs')
      case 'graphiql':
        return $t('Query database using GraphQL')
      case 'vault':
        return $t('View and manage your keys and secrets via Vault')
      default:
        // Interpolate the product name (kept in its own language) into a
        // translatable template; the "s" plural only applies to wrapper names.
        return integration.type === 'wrapper'
          ? $t('View and manage your {{name}}s', { name: integration.name })
          : $t('View and manage your {{name}}', { name: integration.name })
    }
  }

  useRegisterCommands(
    COMMAND_MENU_SECTIONS.NAVIGATE,
    allIntegrations.map((x) => {
      return {
        id: `nav-integrations-${x.id}`,
        name: x.name,
        value: `Integrations: ${x.name}`,
        route: `/project/${ref}/integrations/${x.id}/overview`,
        defaultHidden: true,
      }
    }),
    { ...options, deps: [ref] }
  )

  useRegisterCommands(
    COMMAND_MENU_SECTIONS.INTEGRATIONS,
    allIntegrations.map((x) => {
      return {
        id: `manage-${x.id}`,
        name: getName(x),
        route: `/project/${ref}/integrations/${x.id}/overview`,
        icon: () => (
          <div className="w-6 h-6 relative bg-white border rounded-md flex items-center justify-center [&>img]:p-1! [&>svg]:p-1!">
            {x.icon()}
          </div>
        ),
      }
    }),
    {
      ...options,
      deps: [ref],
      orderSection: orderCommandSectionsByPriority,
      sectionMeta: { priority: 3 },
    }
  )
}
