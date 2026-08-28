import { WorkerDetail } from '@/components/interfaces/Workers/WorkerDetail/WorkerDetail'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { WorkersLayout } from '@/components/layouts/WorkersLayout/WorkersLayout'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const WorkerDetailPage: NextPageWithLayout = () => <WorkerDetail />

WorkerDetailPage.getLayout = (page) => (
  <DefaultLayout>
    <WorkersLayout title={$t('Worker')}>{page}</WorkersLayout>
  </DefaultLayout>
)

export default WorkerDetailPage
