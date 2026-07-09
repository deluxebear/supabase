import { useParams } from 'common'
import { PropsWithChildren } from 'react'

import { PageLayout } from '@/components/layouts/PageLayout/PageLayout'
import { ScaffoldContainer } from '@/components/layouts/Scaffold'
import { t as $t } from '@/lib/i18n'

const JWTKeysLayout = ({ children }: PropsWithChildren) => {
  const { ref: projectRef } = useParams()

  const navigationItems = [
    {
      label: 'JWT Signing Keys',
      href: `/project/${projectRef}/settings/jwt`,
      id: 'signing-keys',
    },
    {
      label: 'Legacy JWT Secret',
      href: `/project/${projectRef}/settings/jwt/legacy`,
      id: 'legacy-jwt-keys',
    },
  ]

  return (
    <PageLayout
      title={$t('JWT Keys')}
      subtitle={$t('Control the keys used to sign JSON Web Tokens for your project')}
      navigationItems={navigationItems}
    >
      <ScaffoldContainer className="flex flex-col py-8 gap-8" bottomPadding>
        {children}
      </ScaffoldContainer>
    </PageLayout>
  )
}

export default JWTKeysLayout
