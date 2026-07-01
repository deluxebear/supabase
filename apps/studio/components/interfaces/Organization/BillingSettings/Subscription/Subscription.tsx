import { PermissionAction, SupportCategories } from '@supabase/shared-types/out/constants'
import { useFlag, useParams } from 'common'
import Link from 'next/link'
import { Button } from 'ui'
import { Admonition } from 'ui-patterns/admonition'
import { ShimmeringLoader } from 'ui-patterns/ShimmeringLoader'

import { Restriction } from '../Restriction'
import { InitiateCancellationFlowButton } from './CancellationFlow'
import { PlanUpdateSidePanel } from './PlanUpdateSidePanel'
import { SupportLink } from '@/components/interfaces/Support/SupportLink'
import {
  ScaffoldSection,
  ScaffoldSectionContent,
  ScaffoldSectionDetail,
} from '@/components/layouts/Scaffold'
import { AlertError } from '@/components/ui/AlertError'
import { NoPermission } from '@/components/ui/NoPermission'
import { useOrgSubscriptionQuery } from '@/data/subscriptions/org-subscription-query'
import { useAsyncCheckPermissions } from '@/hooks/misc/useCheckPermissions'
import { t as $t } from '@/lib/i18n'
import { useOrgSettingsPageStateSnapshot } from '@/state/organization-settings'

const Subscription = () => {
  const { slug } = useParams()
  const snap = useOrgSettingsPageStateSnapshot()
  const projectUpdateDisabled = useFlag('disableProjectCreationAndUpdate')

  const { isSuccess: isPermissionsLoaded, can: canReadSubscriptions } = useAsyncCheckPermissions(
    PermissionAction.BILLING_READ,
    'stripe.subscriptions'
  )

  const {
    data: subscription,
    error,
    isPending: isLoading,
    isError,
    isSuccess,
  } = useOrgSubscriptionQuery({ orgSlug: slug }, { enabled: canReadSubscriptions })

  const currentPlan = subscription?.plan
  const planName = currentPlan?.name ?? 'Unknown'

  const canChangeTier =
    !projectUpdateDisabled && !['enterprise', 'platform'].includes(currentPlan?.id ?? '')

  return (
    <>
      <ScaffoldSection>
        <div className="col-span-12 pb-2">
          <Restriction />
        </div>
        <ScaffoldSectionDetail>
          <div className="sticky space-y-6 top-12">
            <div className="space-y-2 mb-4">
              <p className="text-foreground text-base m-0">{$t('Subscription Plan')}</p>
              <p className="text-sm text-foreground-light m-0">
                {$t(
                  "Each organization has it's own subscription plan, billing cycle, payment methods and usage quotas."
                )}
              </p>
            </div>
          </div>
        </ScaffoldSectionDetail>
        <ScaffoldSectionContent>
          {isPermissionsLoaded && !canReadSubscriptions ? (
            <NoPermission resourceText="view this organization's subscription" />
          ) : (
            <>
              {isLoading && (
                <div className="space-y-2">
                  <ShimmeringLoader />
                  <ShimmeringLoader className="w-3/4" />
                  <ShimmeringLoader className="w-1/2" />
                </div>
              )}

              {isError && <AlertError subject="Failed to retrieve subscription" error={error} />}

              {isSuccess && (
                <div className="space-y-6 w-full">
                  <div className="flex justify-between items-center">
                    <p className="text-2xl text-brand leading-none">
                      {currentPlan?.name ?? 'Unknown'} {$t('Plan')}
                    </p>

                    {canChangeTier && (
                      <div className="flex space-x-2">
                        <Button
                          variant="default"
                          className="pointer-events-auto"
                          onClick={() => snap.setPanelKey('subscriptionPlan')}
                        >
                          {$t('Change subscription plan')}
                        </Button>
                        {currentPlan && currentPlan.id !== 'free' && (
                          <InitiateCancellationFlowButton variant="danger">
                            {$t('Cancel Subscription')}
                          </InitiateCancellationFlowButton>
                        )}
                      </div>
                    )}
                  </div>

                  {!canChangeTier && (
                    <div>
                      {projectUpdateDisabled ? (
                        <Admonition
                          type="default"
                          layout="horizontal"
                          title={`Unable to update plan from ${planName}`}
                          description={$t(
                            'We have temporarily disabled project and subscription changes - our\n                          engineers are working on a fix.'
                          )}
                        />
                      ) : (
                        <Admonition
                          type="default"
                          layout="horizontal"
                          title={`Unable to update plan from ${planName}`}
                          description={$t("Please contact us if you'd like to change your plan.")}
                          actions={
                            <Button asChild key="contact-support" variant="default">
                              <SupportLink
                                queryParams={{
                                  category: SupportCategories.SALES_ENQUIRY,
                                  subject: `Change plan away from ${planName}`,
                                }}
                              >
                                {$t('Contact support')}
                              </SupportLink>
                            </Button>
                          }
                        />
                      )}
                    </div>
                  )}

                  {!subscription?.usage_billing_enabled && (
                    <Admonition
                      type="default"
                      title={$t('This organization is limited by the included usage')}
                    >
                      <div className="[&>p]:leading-normal! prose text-sm">
                        {$t('Projects may become unresponsive when this organization exceeds its')}{' '}
                        <Link href={`/org/${slug}/usage`}>{$t('included usage quota')}</Link>
                        {$t('. To scale seamlessly,')}{' '}
                        {currentPlan?.id === 'free'
                          ? 'upgrade to a paid plan.'
                          : 'you can disable Spend Cap under the Cost Control settings.'}
                      </div>
                    </Admonition>
                  )}
                </div>
              )}
            </>
          )}
        </ScaffoldSectionContent>
      </ScaffoldSection>
      <PlanUpdateSidePanel />
    </>
  )
}

export default Subscription
