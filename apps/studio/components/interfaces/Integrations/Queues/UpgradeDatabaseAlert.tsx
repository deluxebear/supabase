import Link from 'next/link'
import { Button } from 'ui'
import { Admonition } from 'ui-patterns/admonition'

import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { t as $t } from '@/lib/i18n'

interface UpgradeDatabaseAlertProps {
  minimumVersion?: string
}

export const UpgradeDatabaseAlert = ({ minimumVersion = '15.6' }: UpgradeDatabaseAlertProps) => {
  const { data: project } = useSelectedProjectQuery()

  return (
    <Admonition
      type="default"
      title={$t('Database upgrade needed')}
      childProps={{ description: { className: 'flex flex-col gap-y-2' } }}
    >
      <div className="prose text-sm max-w-full">
        <p>
          {$t('This integration requires the')} <code>pgmq</code>{' '}
          {$t(
            'extension which is not available on this version of Postgres. The extension is available on version'
          )}{' '}
          {minimumVersion} {$t('and higher.')}
        </p>
      </div>
      <Button color="primary" className="w-fit">
        <Link href={`/project/${project?.ref}/settings/infrastructure`}>
          {$t('Upgrade database')}
        </Link>
      </Button>
    </Admonition>
  )
}
