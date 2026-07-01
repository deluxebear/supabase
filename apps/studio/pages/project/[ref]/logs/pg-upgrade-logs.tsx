import { useParams } from 'common'

import { LogsPreviewer } from '@/components/interfaces/Settings/Logs/LogsPreviewer'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import LogsLayout from '@/components/layouts/LogsLayout/LogsLayout'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

export const LogPage: NextPageWithLayout = () => {
  const { ref } = useParams()
  return <LogsPreviewer condensedLayout queryType="pg_upgrade" projectRef={ref as string} />
}

LogPage.getLayout = (page) => (
  <DefaultLayout>
    <LogsLayout title={$t('Postgres Version Upgrade')}>{page}</LogsLayout>
  </DefaultLayout>
)

export default LogPage
