import { useParams } from 'common'
import { useRouter } from 'next/router'
import type { PropsWithChildren } from 'react'

import { ProjectLayout } from '../ProjectLayout'
import { isAuthConfigurationPage, useGenerateAuthMenu } from './AuthLayout.utils'
import { AuthConfigDesiredStateNotice } from '@/components/interfaces/Auth/AuthConfigDesiredStateNotice'
import { ProductMenu } from '@/components/ui/ProductMenu'
import { ProductMenuShortcuts } from '@/components/ui/ProductMenu/ProductMenuShortcuts'
import { useAuthConfigPrefetch } from '@/data/auth/auth-config-query'
import { withAuth } from '@/hooks/misc/withAuth'
import { IS_AUTH_CONFIGURATION_DESIRED_STATE_ONLY } from '@/lib/constants/deployment-profile'

export const AuthProductMenu = () => {
  const router = useRouter()
  const { ref: projectRef = 'default' } = useParams()

  useAuthConfigPrefetch({ projectRef })
  const page = router.pathname.split('/')[4]
  const menu = useGenerateAuthMenu()

  return <ProductMenu page={page} menu={menu} />
}

const AuthLayout = ({ title, children }: PropsWithChildren<{ title: string }>) => {
  const router = useRouter()
  const { ref: projectRef = 'default' } = useParams()

  useAuthConfigPrefetch({ projectRef })
  const page = router.pathname.split('/')[4]
  const menu = useGenerateAuthMenu()
  const shouldShowDesiredStateNotice =
    IS_AUTH_CONFIGURATION_DESIRED_STATE_ONLY && isAuthConfigurationPage(page)

  return (
    <ProjectLayout
      product="Authentication"
      browserTitle={{ section: title }}
      productMenu={<ProductMenu page={page} menu={menu} />}
      isBlocking={false}
    >
      <ProductMenuShortcuts menu={menu} />
      {shouldShowDesiredStateNotice && <AuthConfigDesiredStateNotice />}
      {children}
    </ProjectLayout>
  )
}

/**
 * Layout for all auth pages on the dashboard, wrapped with withAuth to verify logged in state
 *
 * Handles rendering the navigation for each section under the auth pages.
 */
export default withAuth(AuthLayout)
