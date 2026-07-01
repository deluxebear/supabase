import { StoragePolicies } from '@/components/interfaces/Storage/StoragePolicies/StoragePolicies'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { StorageBucketsLayout } from '@/components/layouts/StorageLayout/StorageBucketsLayout'
import StorageLayout from '@/components/layouts/StorageLayout/StorageLayout'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const FilesPoliciesPage: NextPageWithLayout = () => {
  return <StoragePolicies />
}

FilesPoliciesPage.getLayout = (page) => (
  <DefaultLayout>
    <StorageLayout title={$t('Policies')}>
      <StorageBucketsLayout>{page}</StorageBucketsLayout>
    </StorageLayout>
  </DefaultLayout>
)

export default FilesPoliciesPage
