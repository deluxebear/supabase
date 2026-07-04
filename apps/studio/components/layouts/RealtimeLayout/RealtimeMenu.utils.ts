import type { ProductMenuGroup } from '@/components/ui/ProductMenu/ProductMenu.types'
import type { Project } from '@/data/projects/project-detail-query'
import { IS_PLATFORM } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'
import { SHORTCUT_IDS } from '@/state/shortcuts/registry'

export const generateRealtimeMenu = (project: Project | undefined): ProductMenuGroup[] => {
  const ref = project?.ref ?? 'default'
  const showRealtimeSettings = IS_PLATFORM

  return [
    {
      title: $t('Tools'),
      items: [
        {
          name: $t('Inspector'),
          key: 'inspector',
          url: `/project/${ref}/realtime/inspector`,
          items: [],
          shortcutId: SHORTCUT_IDS.NAV_REALTIME_INSPECTOR,
        },
      ],
    },
    {
      title: $t('Configuration'),
      items: [
        {
          name: $t('Policies'),
          key: 'policies',
          url: `/project/${ref}/realtime/policies`,
          items: [],
          shortcutId: SHORTCUT_IDS.NAV_REALTIME_POLICIES,
        },
        ...(showRealtimeSettings
          ? [
              {
                name: $t('Settings'),
                key: 'settings',
                url: `/project/${ref}/realtime/settings`,
                items: [],
                shortcutId: SHORTCUT_IDS.NAV_REALTIME_SETTINGS,
              },
            ]
          : []),
      ],
    },
  ]
}
