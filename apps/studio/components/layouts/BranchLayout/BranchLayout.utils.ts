import type { ProductMenuGroup } from '@/components/ui/ProductMenu/ProductMenu.types'
import { t as $t } from '@/lib/i18n'

export const generateBranchMenu = (ref: string): ProductMenuGroup[] => {
  return [
    {
      title: $t('Manage'),
      items: [
        {
          name: $t('Branches'),
          key: 'branches',
          url: `/project/${ref}/branches`,
          items: [],
        },
        {
          name: $t('Merge requests'),
          key: 'merge-requests',
          url: `/project/${ref}/branches/merge-requests`,
          items: [],
        },
      ],
    },
  ]
}
