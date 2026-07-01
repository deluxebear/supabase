import { SupportCategories } from '@supabase/shared-types/out/constants'
import { useParams } from 'common'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from 'ui'
import { Admonition } from 'ui-patterns/admonition'

import { useCheckEligibilityDeployReplica } from './useCheckEligibilityDeployReplica'
import { SupportLink } from '@/components/interfaces/Support/SupportLink'
import { DocsButton } from '@/components/ui/DocsButton'
import { UpgradePlanButton } from '@/components/ui/UpgradePlanButton'
import { useEnablePhysicalBackupsMutation } from '@/data/database/enable-physical-backups-mutation'
import { useProjectDetailQuery } from '@/data/projects/project-detail-query'
import { READ_REPLICAS_MAX_COUNT } from '@/data/read-replicas/replicas-query'
import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

export const ReadReplicaEligibilityWarnings = () => {
  const { ref: projectRef } = useParams()
  const { data: org } = useSelectedOrganizationQuery()
  const { data: project } = useSelectedProjectQuery()

  const [refetchInterval, setRefetchInterval] = useState<number | false>(false)

  const {
    hasOverdueInvoices,
    isAWSProvider,
    isAwsK8s,
    isPgVersionBelow15,
    isBelowSmallCompute,
    isWalgNotEnabled,
    isProWithSpendCapEnabled,
    isReachedMaxReplicas,
    maxNumberOfReplicas,
  } = useCheckEligibilityDeployReplica()

  const { data: projectDetail, isSuccess: isProjectDetailSuccess } = useProjectDetailQuery(
    { ref: projectRef },
    {
      refetchInterval,
      refetchOnWindowFocus: false,
    }
  )

  const { mutate: enablePhysicalBackups, isPending: isEnabling } = useEnablePhysicalBackupsMutation(
    {
      onSuccess: () => {
        toast.success(
          $t('Physical backups are currently being enabled, please check back in a few minutes!')
        )
        setRefetchInterval(5000)
      },
    }
  )

  useEffect(() => {
    if (!isProjectDetailSuccess) return
    if (projectDetail.is_physical_backups_enabled) {
      setRefetchInterval(false)
    }
  }, [projectDetail?.is_physical_backups_enabled, isProjectDetailSuccess])

  if (hasOverdueInvoices) {
    return (
      <Admonition type="warning" title={$t('Your organization has overdue invoices')}>
        <p>
          {$t('Please resolve all outstanding invoices first before deploying a new read replica.')}
        </p>
        <Button asChild variant="default" className="mt-2">
          <Link href={`/org/${org?.slug}/billing#invoices`}>{$t('View invoices')}</Link>
        </Button>
      </Admonition>
    )
  }

  if (!isAWSProvider) {
    return (
      <Admonition
        type="warning"
        title={$t('Read replicas are only supported for projects provisioned via AWS')}
      >
        <p>
          {$t(
            'Projects provisioned by other cloud providers currently will not be able to use read replicas.'
          )}
        </p>
        <DocsButton
          abbrev={false}
          className="mt-2"
          href={`${DOCS_URL}/guides/platform/read-replicas#prerequisites`}
        />
      </Admonition>
    )
  }

  if (isAwsK8s) {
    return (
      <Admonition
        type="warning"
        title={$t('Read replicas are not supported for AWS (Revamped) projects')}
        description={$t(
          'Projects provisioned by other cloud providers currently will not be able to use read replicas.'
        )}
      />
    )
  }

  if (isPgVersionBelow15) {
    return (
      <Admonition
        type="warning"
        title={$t(
          'Read replicas can only be deployed with projects on Postgres version 15 and above'
        )}
      >
        <p>{$t("If you'd like to use read replicas, please contact us via support.")}</p>
        <Button asChild variant="default" className="mt-2">
          <SupportLink
            queryParams={{
              projectRef,
              category: SupportCategories.SALES_ENQUIRY,
              subject: 'Enquiry on read replicas',
              message: `Project DB version: ${project?.dbVersion}`,
            }}
          >
            {$t('Contact support')}
          </SupportLink>
        </Button>
      </Admonition>
    )
  }

  if (isBelowSmallCompute) {
    return (
      <Admonition type="warning" title={$t('Project required to at least be on a Small compute')}>
        <p>
          {$t(
            "This is to ensure that read replicas can keep up with the primary databases' activities."
          )}
        </p>
        <div className="flex items-center gap-x-2 mt-2">
          <UpgradePlanButton
            variant="default"
            plan="Pro"
            addon="computeSize"
            source="read-replicas"
            featureProposition="deploy Read Replicas"
          />
          <DocsButton href={`${DOCS_URL}/guides/platform/read-replicas#prerequisites`} />
        </div>
      </Admonition>
    )
  }

  if (isWalgNotEnabled) {
    return (
      <Admonition
        type="warning"
        title={
          refetchInterval === false
            ? 'Physical backups are required to deploy replicas'
            : 'Physical backups are currently being enabled'
        }
      >
        {refetchInterval === false ? (
          <>
            <p>
              {$t(
                'Physical backups are used under the hood to spin up read replicas for your project.'
              )}
            </p>
            <p>
              {$t(
                'Enabling physical backups will take a few minutes, after which you will be able to deploy read replicas.'
              )}
            </p>
          </>
        ) : (
          <>
            <p>
              {$t(
                'This warning will go away once physical backups have been enabled - check back in a few minutes!'
              )}
            </p>
            <p>{$t('You may start deploying read replicas thereafter once this is completed.')}</p>
          </>
        )}
        {refetchInterval === false && (
          <div className="flex items-center gap-x-2 mt-2">
            <Button
              variant="default"
              loading={isEnabling}
              disabled={isEnabling}
              onClick={() => {
                if (projectRef) enablePhysicalBackups({ ref: projectRef })
              }}
            >
              {$t('Enable physical backups')}
            </Button>
            <DocsButton
              abbrev={false}
              href={`${DOCS_URL}/guides/platform/read-replicas#how-are-read-replicas-made`}
            />
          </div>
        )}
      </Admonition>
    )
  }

  if (isProWithSpendCapEnabled) {
    return (
      <Admonition type="warning" title={$t('Spend cap needs to be disabled to deploy replicas')}>
        <p>
          {$t(
            "Launching a replica incurs additional disk size that will exceed the plan's quota. Disable the spend cap first to allow overages before launching a replica."
          )}
        </p>
        <UpgradePlanButton
          variant="default"
          source="read-replicas"
          addon="spendCap"
          className="mt-2"
        >
          {$t('Disable spend cap')}
        </UpgradePlanButton>
      </Admonition>
    )
  }

  if (isReachedMaxReplicas) {
    return (
      <Admonition
        type="warning"
        title={`You can only deploy up to ${maxNumberOfReplicas} read replicas at once`}
      >
        <p>
          {$t(
            "If you'd like to spin up another read replica, please drop an existing replica first."
          )}
        </p>
        {maxNumberOfReplicas < READ_REPLICAS_MAX_COUNT && (
          <>
            <p>
              {$t('Alternatively, you may deploy up to')}{' '}
              <span className="text-foreground">{READ_REPLICAS_MAX_COUNT}</span>{' '}
              {$t('replicas if your project is on an XL compute or higher.')}
            </p>
            <UpgradePlanButton
              variant="default"
              plan="Pro"
              addon="computeSize"
              source="read-replicas"
              featureProposition="deploy Read Replicas"
              className="mt-2"
            >
              {$t('Change compute size')}
            </UpgradePlanButton>
          </>
        )}
      </Admonition>
    )
  }
}
