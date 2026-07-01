import { useParams } from 'common'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { Alert, AlertDescription, AlertTitle, Button } from 'ui'

import ConfirmDisableReadOnlyModeModal from './DatabaseSettings/ConfirmDisableReadOnlyModal'
import { useResourceWarningsQuery } from '@/data/usage/resource-warnings-query'
import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'
import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

export const DatabaseReadOnlyAlert = () => {
  const { ref: projectRef } = useParams()
  const { data: organization } = useSelectedOrganizationQuery()
  const [showConfirmationModal, setShowConfirmationModal] = useState(false)

  const { data: resourceWarnings } = useResourceWarningsQuery({ ref: projectRef })
  // [Joshen Cleanup] JFYI this can be cleaned up once BE changes are live which will only return the warnings based on the provided ref
  // No longer need to filter by ref on the client side
  const isReadOnlyMode =
    (resourceWarnings ?? [])?.find((warning) => warning.project === projectRef)
      ?.is_readonly_mode_enabled ?? false

  return (
    <>
      {isReadOnlyMode && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>
            {$t('Project is in read-only mode and database is no longer accepting write requests')}
          </AlertTitle>
          <AlertDescription>
            {$t(
              "You have reached 95% of your project's disk space, and read-only mode has been enabled to preserve your database's stability and prevent your project from exceeding its current billing plan. To resolve this, you may:"
            )}
            <ul className="list-disc pl-6 mt-1">
              <li>
                {$t(
                  'Temporarily disable read-only mode to free up space and reduce your database size'
                )}
              </li>
              {organization?.plan.id === 'free' ? (
                <li>
                  <Link
                    href={`/org/${organization?.slug}/billing?panel=subscriptionPlan&source=databaseReadOnlyAlertUpgradePlan`}
                  >
                    <a className="text underline">{$t('Upgrade to the Pro Plan')}</a>
                  </Link>{' '}
                  {$t('to increase your database size limit to 8GB.')}
                </li>
              ) : organization?.plan.id === 'pro' && organization?.usage_billing_enabled ? (
                <li>
                  <Link
                    href={`/org/${organization?.slug}/billing?panel=subscriptionPlan&source=databaseReadOnlyAlertSpendCap`}
                  >
                    <a className="text-foreground underline">{$t('Disable your Spend Cap')}</a>
                  </Link>{' '}
                  {$t(
                    'to allow your project to auto-scale and expand beyond the 8GB database size limit'
                  )}
                </li>
              ) : null}
            </ul>
          </AlertDescription>
          <div className="mt-4 flex items-center space-x-2">
            <Button variant="default" onClick={() => setShowConfirmationModal(true)}>
              {$t('Disable read-only mode')}
            </Button>
            <Button asChild variant="default" icon={<ExternalLink />}>
              <a
                href={`${DOCS_URL}/guides/platform/database-size#disabling-read-only-mode`}
                target="_blank"
                rel="noreferrer"
              >
                {$t('Learn more')}
              </a>
            </Button>
          </div>
        </Alert>
      )}
      <ConfirmDisableReadOnlyModeModal
        visible={showConfirmationModal}
        onClose={() => setShowConfirmationModal(false)}
      />
    </>
  )
}
