import { PermissionAction } from '@supabase/shared-types/out/constants'
import { parseAsBoolean, useQueryState } from 'nuqs'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogSectionSeparator,
  DialogTitle,
  RadioGroupStacked,
  RadioGroupStackedItem,
} from 'ui'

import { ButtonTooltip } from '@/components/ui/ButtonTooltip'
import { useOrganizationCustomerProfileUpdateMutation } from '@/data/organizations/organization-customer-profile-update-mutation'
import { useAsyncCheckPermissions } from '@/hooks/misc/useCheckPermissions'
import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'
import { IS_PLATFORM } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

type IndirectTaxDeclaration = 'yes' | 'no'
type DeclarationModal = 'declaration-form' | 'submission-confirmation' | null

export const IndirectTaxDeclarationModal = () => {
  const { data: organization } = useSelectedOrganizationQuery({ enabled: IS_PLATFORM })

  const [response, setResponse] = useState<IndirectTaxDeclaration | ''>('')
  const [failedSubmissionSlug, setFailedSubmissionSlug] = useState<string>()

  const [shouldShowDeclarationConfirmation, setShouldShowDeclarationConfirmation] = useQueryState(
    'submit_indirect_tax_declaration',
    parseAsBoolean.withDefault(false)
  )

  useEffect(() => {
    setResponse('')
  }, [organization?.slug])

  const { can: canUpdateBillingInfo, isSuccess: permissionsLoaded } = useAsyncCheckPermissions(
    PermissionAction.BILLING_WRITE,
    'stripe.customer'
  )

  const { mutate: updateCustomerProfile, isPending } = useOrganizationCustomerProfileUpdateMutation(
    {
      onSuccess: () => {
        if (!shouldShowDeclarationConfirmation) {
          toast.success($t('GST declaration submitted'))
        }
      },
      onError: (_error, variables) => {
        setFailedSubmissionSlug(variables.slug)
        toast.error($t("We couldn't submit your GST declaration. Reload the page and try again."), {
          duration: Infinity,
        })
      },
    }
  )

  const canViewDeclaration =
    IS_PLATFORM && organization !== undefined && permissionsLoaded && canUpdateBillingInfo

  let declarationModal: DeclarationModal = null

  if (canViewDeclaration) {
    if (organization.requires_indirect_tax_declaration) {
      if (organization.slug !== failedSubmissionSlug) {
        declarationModal = 'declaration-form'
      }
    } else if (shouldShowDeclarationConfirmation) {
      declarationModal = 'submission-confirmation'
    }
  }

  const onSubmit = () => {
    if (organization?.slug === undefined || response === '') return

    updateCustomerProfile({
      slug: organization.slug,
      indirect_tax_registration_declaration: response,
    })
  }

  const closeSubmissionConfirmation = () => {
    setShouldShowDeclarationConfirmation(null)
  }

  return (
    <>
      <Dialog open={declarationModal === 'declaration-form'}>
        <DialogContent
          size="medium"
          hideClose
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>{$t('Confirm your Australian GST status')}</DialogTitle>
            <DialogDescription>
              {$t('Confirm the following for your organization')} {organization?.name}
            </DialogDescription>
          </DialogHeader>
          <DialogSectionSeparator />

          <DialogSection className="py-4">
            <RadioGroupStacked
              className="[&_p]:text-pretty"
              value={response}
              onValueChange={(value) => {
                if (value === 'yes' || value === 'no') setResponse(value)
              }}
            >
              <RadioGroupStackedItem
                value="yes"
                label={$t('Yes, I confirm')}
                description={$t(
                  'We are and were registered for GST in Australia when we acquired services from Supabase, and the services were acquired in the course or furtherance of our business.'
                )}
              />
              <RadioGroupStackedItem
                value="no"
                label={$t('No, I do not confirm')}
                description={$t(
                  'We are not or were not registered for GST in Australia when we acquired services from Supabase, or the services were acquired for a purpose unrelated to our business.'
                )}
              />
            </RadioGroupStacked>
          </DialogSection>

          <DialogFooter>
            <ButtonTooltip
              variant="primary"
              onClick={onSubmit}
              disabled={response === ''}
              loading={isPending}
              tooltip={{
                content: {
                  side: 'top',
                  text: response === '' ? 'Select Yes or No to continue' : undefined,
                },
              }}
            >
              {$t('Submit declaration')}
            </ButtonTooltip>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={declarationModal === 'submission-confirmation'}
        onOpenChange={(open) => {
          if (!open) closeSubmissionConfirmation()
        }}
      >
        <DialogContent size="small">
          <DialogHeader>
            <DialogTitle>{$t('GST declaration submitted')}</DialogTitle>
            <DialogDescription>
              {$t('The GST declaration for')} {organization?.name}{' '}
              {$t('has been submitted. No further action is required.')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={closeSubmissionConfirmation}>{$t('Close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
