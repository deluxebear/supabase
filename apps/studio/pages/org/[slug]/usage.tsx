import { Usage } from '@/components/interfaces/Organization/Usage/Usage'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import OrganizationLayout from '@/components/layouts/OrganizationLayout'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const OrgUsage: NextPageWithLayout = () => {
  return <Usage />
}

OrgUsage.getLayout = (page) => (
  <DefaultLayout>
    <OrganizationLayout title={$t('Usage')}>{page}</OrganizationLayout>
  </DefaultLayout>
)

export default OrgUsage
