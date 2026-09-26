import { useParams } from 'common'
import { useRouter } from 'next/router'
import { useEffect } from 'react'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import { getReadReplicaPath } from '@/components/interfaces/Settings/Infrastructure/Infrastructure.utils'
import { DatabaseLayout } from '@/components/layouts/DatabaseLayout/DatabaseLayout'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { UnknownInterface } from '@/components/ui/UnknownInterface'
import { STUDIO_CAPABILITIES } from '@/lib/constants/deployment-profile'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const DatabaseReadReplicaRedirectPage: NextPageWithLayout = () => {
  const { ref } = useParams()
  if (!STUDIO_CAPABILITIES.etlReplication) {
    return <UnknownInterface urlBack={`/project/${ref}/database/schemas`} />
  }
  return <DatabaseReadReplicaRedirectContent />
}

/** @deprecated Redirects to Settings → Infrastructure replica detail. */
const DatabaseReadReplicaRedirectContent = () => {
  const router = useRouter()
  const { ref, replicaId } = useParams()

  useEffect(() => {
    if (!ref || !replicaId) return
    router.replace(getReadReplicaPath(ref, replicaId))
  }, [ref, replicaId, router])

  return (
    <div className="p-6">
      <GenericSkeletonLoader />
    </div>
  )
}

DatabaseReadReplicaRedirectPage.getLayout = (page) => (
  <DefaultLayout>
    <DatabaseLayout title={$t('Replication')}>{page}</DatabaseLayout>
  </DefaultLayout>
)

export default DatabaseReadReplicaRedirectPage
