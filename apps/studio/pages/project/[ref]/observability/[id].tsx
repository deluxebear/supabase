import ReportPadding from '@/components/interfaces/Reports/ReportPadding'
import Reports from '@/components/interfaces/Reports/Reports'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import ObservabilityLayout from '@/components/layouts/ObservabilityLayout/ObservabilityLayout'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const PageLayout: NextPageWithLayout = () => (
  <div className="mx-auto flex flex-col gap-4 w-full grow">
    <ReportPadding>
      <Reports />
    </ReportPadding>
  </div>
)

PageLayout.getLayout = (page) => (
  <DefaultLayout>
    <ObservabilityLayout title={$t('Report')}>{page}</ObservabilityLayout>
  </DefaultLayout>
)

export default PageLayout
