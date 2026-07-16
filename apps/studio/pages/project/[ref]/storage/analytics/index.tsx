import { useParams } from 'common'

import { AnalyticsBuckets } from '@/components/interfaces/Storage/AnalyticsBuckets'
import { BucketsUpgradePlan } from '@/components/interfaces/Storage/BucketsUpgradePlan'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { StorageBucketsLayout } from '@/components/layouts/StorageLayout/StorageBucketsLayout'
import StorageLayout from '@/components/layouts/StorageLayout/StorageLayout'
import { UnknownInterface } from '@/components/ui/UnknownInterface'
import { useIsAnalyticsBucketsEnabled } from '@/data/config/project-storage-config-query'
import { STUDIO_CAPABILITIES } from '@/lib/constants/deployment-profile'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const StorageAnalyticsPage: NextPageWithLayout = () => {
  const { ref: projectRef } = useParams()
  const isAnalyticsBucketsEnabled = useIsAnalyticsBucketsEnabled({ projectRef })

  if (!STUDIO_CAPABILITIES.storageAnalytics) {
    return <UnknownInterface urlBack={`/project/${projectRef}/storage/files`} />
  } else if (!isAnalyticsBucketsEnabled) {
    return <BucketsUpgradePlan type="analytics" />
  } else {
    return <AnalyticsBuckets />
  }
}

StorageAnalyticsPage.getLayout = (page) => (
  <DefaultLayout>
    <StorageLayout title={$t('Analytics')}>
      <StorageBucketsLayout>{page}</StorageBucketsLayout>
    </StorageLayout>
  </DefaultLayout>
)

export default StorageAnalyticsPage
