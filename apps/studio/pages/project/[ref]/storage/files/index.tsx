import { FilesBuckets } from '@/components/interfaces/Storage/FilesBuckets'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { StorageBucketsLayout } from '@/components/layouts/StorageLayout/StorageBucketsLayout'
import StorageLayout from '@/components/layouts/StorageLayout/StorageLayout'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const StorageFilesPage: NextPageWithLayout = () => {
  return <FilesBuckets />
}

StorageFilesPage.getLayout = (page) => (
  <DefaultLayout>
    <StorageLayout title={$t('Files')}>
      <StorageBucketsLayout>{page}</StorageBucketsLayout>
    </StorageLayout>
  </DefaultLayout>
)

export default StorageFilesPage
