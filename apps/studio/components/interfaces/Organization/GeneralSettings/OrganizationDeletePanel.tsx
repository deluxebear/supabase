import { Admonition } from 'ui-patterns/admonition'

import { DeleteOrganizationButton } from './DeleteOrganizationButton'
import PartnerManagedResource from '@/components/ui/PartnerManagedResource'
import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'
import { MANAGED_BY } from '@/lib/constants/infrastructure'
import { t as $t } from '@/lib/i18n'

export const OrganizationDeletePanel = () => {
  const { data: selectedOrganization } = useSelectedOrganizationQuery()

  return selectedOrganization?.managed_by !== 'vercel-marketplace' ? (
    <Admonition
      type="destructive"
      title={$t('Deleting this organization will also remove its projects')}
      description={$t(
        'Make sure you have made a backup of your projects if you want to keep your data'
      )}
    >
      <DeleteOrganizationButton />
    </Admonition>
  ) : (
    <PartnerManagedResource
      managedBy={MANAGED_BY.VERCEL_MARKETPLACE}
      resource="Organizations"
      cta={{
        installationId: selectedOrganization?.partner_id,
        path: '/settings',
        message: 'Delete organization in Vercel Marketplace',
      }}
    />
  )
}
