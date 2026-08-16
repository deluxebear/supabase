import Link from 'next/link'
import { useRouter } from 'next/router'
import { Badge, NavMenu, NavMenuItem } from 'ui'

import { useIsFeatureEnabled } from '@/hooks/misc/useIsFeatureEnabled'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'
import { t as $t } from '@/lib/i18n'

type Props = {
  active: 'pitr' | 'scheduled' | 'rtnp'
}

function DatabaseBackupsNav({ active }: Props) {
  const router = useRouter()
  const { ref } = useSelectedProjectQuery()?.data || {}
  const projectRef = ref ?? (typeof router.query.ref === 'string' ? router.query.ref : undefined)
  const { databaseRestoreToNewProject } = useIsFeatureEnabled(['database:restore_to_new_project'])

  const navMenuItems = [
    {
      enabled: true,
      id: 'scheduled',
      label: 'Scheduled backups',
      href: projectRef ? `/project/${projectRef}/database/backups/scheduled` : router.asPath,
    },
    {
      enabled: true,
      id: 'pitr',
      label: 'Point in time',
      href: projectRef ? `/project/${projectRef}/database/backups/pitr` : router.asPath,
    },
    {
      enabled: databaseRestoreToNewProject && !IS_SELF_PLATFORM,
      id: 'rtnp',
      label: (
        <div className="flex items-center gap-2">
          {$t('Restore to new project')} <Badge variant="warning">{$t('Beta')}</Badge>
        </div>
      ),
      href: projectRef
        ? `/project/${projectRef}/database/backups/restore-to-new-project`
        : router.asPath,
    },
  ] as const

  return (
    <NavMenu className="overflow-hidden overflow-x-auto">
      {navMenuItems.map(
        (item) =>
          item.enabled && (
            <NavMenuItem key={item.id} active={item.id === active}>
              <Link href={item.href}>{item.label}</Link>
            </NavMenuItem>
          )
      )}
    </NavMenu>
  )
}

export default DatabaseBackupsNav
