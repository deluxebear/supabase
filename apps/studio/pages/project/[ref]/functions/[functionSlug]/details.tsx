import { EdgeFunctionDetails } from '@/components/interfaces/Functions/EdgeFunctionDetails/EdgeFunctionDetails'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import EdgeFunctionDetailsLayout from '@/components/layouts/EdgeFunctionsLayout/EdgeFunctionDetailsLayout'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const PageLayout: NextPageWithLayout = () => <EdgeFunctionDetails />

PageLayout.getLayout = (page) => (
  <DefaultLayout>
    <EdgeFunctionDetailsLayout title={$t('Settings')}>{page}</EdgeFunctionDetailsLayout>
  </DefaultLayout>
)

export default PageLayout
