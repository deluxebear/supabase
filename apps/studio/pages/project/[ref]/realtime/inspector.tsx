import { RealtimeInspector } from '@/components/interfaces/Realtime/Inspector'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import RealtimeLayout from '@/components/layouts/RealtimeLayout/RealtimeLayout'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

export const InspectorPage: NextPageWithLayout = () => {
  return <RealtimeInspector />
}

InspectorPage.getLayout = (page) => (
  <DefaultLayout>
    <RealtimeLayout title={$t('Realtime Inspector')}>{page}</RealtimeLayout>
  </DefaultLayout>
)

export default InspectorPage
