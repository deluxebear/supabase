import { useParams } from 'common'
import { ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { Alert, AlertDescription, AlertTitle, Button, WarningIcon } from 'ui'

import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

export const AuthAlert = ({
  title,
  isHookSendSMSEnabled,
}: {
  title: string
  isHookSendSMSEnabled: boolean
}) => {
  const { ref } = useParams()

  switch (title) {
    // TODO (KM): Remove after 10th October 2024 when we disable the provider
    case 'Slack (Deprecated)':
      return (
        <Alert variant="warning">
          <WarningIcon />
          <AlertTitle>{$t('Slack (Deprecated) Provider')}</AlertTitle>
          <AlertDescription>
            {$t(
              'Recently, Slack has updated their OAuth API. Please use the new Slack (OIDC) provider below. Developers using this provider should move over to the new provider. Please refer to our'
            )}{' '}
            <a
              href={`${DOCS_URL}/guides/auth/social-login/auth-slack`}
              className="underline"
              target="_blank"
            >
              documentation
            </a>{' '}
            {$t('for more details.')}
          </AlertDescription>
        </Alert>
      )
    case 'Phone':
      return (
        isHookSendSMSEnabled && (
          <Alert>
            <WarningIcon />
            <AlertTitle>
              {$t('SMS provider settings are disabled while the SMS hook is enabled.')}
            </AlertTitle>
            <AlertDescription className="flex flex-col gap-y-3">
              <p>{$t('The SMS hook will be used in place of the SMS provider configured')}</p>
              <Button asChild variant="default" className="w-min" icon={<ExternalLink />}>
                <Link href={`/project/${ref}/auth/hooks`}>{$t('View auth hooks')}</Link>
              </Button>
            </AlertDescription>
          </Alert>
        )
      )
    default:
      return null
  }
}
