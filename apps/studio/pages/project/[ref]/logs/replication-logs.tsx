import { useParams } from 'common'

import { LogsTableName } from '@/components/interfaces/Settings/Logs/Logs.constants'
import { LogsPreviewer } from '@/components/interfaces/Settings/Logs/LogsPreviewer'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import LogsLayout from '@/components/layouts/LogsLayout/LogsLayout'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

export const LogPage: NextPageWithLayout = () => {
  const { ref } = useParams()

  return (
    <LogsPreviewer
      condensedLayout
      queryType="etl"
      projectRef={ref!}
      tableName={LogsTableName.ETL}
    />
  )
}

LogPage.getLayout = (page) => (
  <DefaultLayout>
    <LogsLayout title={$t('Replication Logs')}>{page}</LogsLayout>
  </DefaultLayout>
)

export default LogPage
