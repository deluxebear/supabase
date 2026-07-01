import { PermissionAction } from '@supabase/shared-types/out/constants'

import { InvoicesSettings } from './InvoicesSettings'
import {
  ScaffoldSection,
  ScaffoldSectionContent,
  ScaffoldSectionDetail,
} from '@/components/layouts/Scaffold'
import { NoPermission } from '@/components/ui/NoPermission'
import { useAsyncCheckPermissions } from '@/hooks/misc/useCheckPermissions'
import { t as $t } from '@/lib/i18n'

export const InvoicesSection = () => {
  const { isSuccess: isPermissionsLoaded, can: canReadInvoices } = useAsyncCheckPermissions(
    PermissionAction.BILLING_READ,
    'stripe.subscriptions'
  )

  return (
    <ScaffoldSection>
      <ScaffoldSectionDetail>
        <div className="sticky space-y-2 top-12 pr-6">
          <p className="text-foreground text-base m-0">{$t('Past Invoices')}</p>

          <p className="prose text-sm">
            {$t(
              'You get an invoice every time you change your plan or when your monthly billing cycle resets.'
            )}
          </p>
        </div>
      </ScaffoldSectionDetail>
      <ScaffoldSectionContent>
        {isPermissionsLoaded && !canReadInvoices ? (
          <NoPermission resourceText="view this organization's upcoming invoice" />
        ) : (
          <InvoicesSettings />
        )}
      </ScaffoldSectionContent>
    </ScaffoldSection>
  )
}
