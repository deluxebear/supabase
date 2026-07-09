import { useParams } from 'common'
import { PropsWithChildren } from 'react'

import AuthLayout from './AuthLayout'
import { PageLayout } from '@/components/layouts/PageLayout/PageLayout'
import { UnknownInterface } from '@/components/ui/UnknownInterface'
import { useIsFeatureEnabled } from '@/hooks/misc/useIsFeatureEnabled'
import { t as $t } from '@/lib/i18n'

export const AuthEmailsLayout = ({ children }: PropsWithChildren<{}>) => {
  const { ref } = useParams()

  const showEmails = useIsFeatureEnabled('authentication:emails')

  const navItems = [
    {
      label: $t('Templates'),
      href: `/project/${ref}/auth/templates`,
    },
    {
      label: $t('SMTP Settings'),
      href: `/project/${ref}/auth/smtp`,
    },
  ]

  return (
    <AuthLayout title={$t('Emails')}>
      {showEmails ? (
        <PageLayout
          title={$t('Emails')}
          subtitle={$t('Configure what emails your users receive and how they are sent')}
          navigationItems={navItems}
        >
          {children}
        </PageLayout>
      ) : (
        <UnknownInterface urlBack={`/project/${ref}/auth/users`} />
      )}
    </AuthLayout>
  )
}
