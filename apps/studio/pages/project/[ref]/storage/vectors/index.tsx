import { IS_PLATFORM, useParams } from 'common'

import { BucketsUpgradePlan } from '@/components/interfaces/Storage/BucketsUpgradePlan'
import { VectorsBuckets } from '@/components/interfaces/Storage/VectorBuckets'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { StorageBucketsLayout } from '@/components/layouts/StorageLayout/StorageBucketsLayout'
import StorageLayout from '@/components/layouts/StorageLayout/StorageLayout'
import { UnknownInterface } from '@/components/ui/UnknownInterface'
import { useIsVectorBucketsEnabled } from '@/data/config/project-storage-config-query'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import type { NextPageWithLayout } from '@/types'

const StorageVectorsPage: NextPageWithLayout = () => {
  const { ref: projectRef } = useParams()
  const isVectorBucketsEnabled = useIsVectorBucketsEnabled({ projectRef })

  if (!STUDIO_CAPABILITIES.storageVectors && STUDIO_DEPLOYMENT_PROFILE !== 'cli') {
    return <UnknownInterface urlBack={`/project/${projectRef}/storage/files`} />
  } else if (IS_PLATFORM && !isVectorBucketsEnabled) {
    return <BucketsUpgradePlan type="vector" />
  } else if (!isVectorBucketsEnabled) {
    return null
  } else {
    return <VectorsBuckets />
  }
}

StorageVectorsPage.getLayout = (page) => (
  <DefaultLayout>
    <StorageLayout title={'Vectors'}>
      <StorageBucketsLayout>{page}</StorageBucketsLayout>
    </StorageLayout>
  </DefaultLayout>
)

export default StorageVectorsPage
