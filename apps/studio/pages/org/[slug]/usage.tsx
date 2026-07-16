import { useParams } from 'common'

import { Usage } from '@/components/interfaces/Organization/Usage/Usage'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import OrganizationLayout from '@/components/layouts/OrganizationLayout'
import { UnknownInterface } from '@/components/ui/UnknownInterface'
import { STUDIO_CAPABILITIES } from '@/lib/constants/deployment-profile'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const OrgUsage: NextPageWithLayout = () => {
  const { slug } = useParams()

  if (!STUDIO_CAPABILITIES.hostedOrganizationUsage) {
    return <UnknownInterface urlBack={`/org/${slug}`} />
  }

  return <Usage />
}

OrgUsage.getLayout = (page) => (
  <DefaultLayout>
    <OrganizationLayout title={$t('Usage')}>{page}</OrganizationLayout>
  </DefaultLayout>
)

export default OrgUsage
