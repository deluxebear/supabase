import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from 'ui'

import {
  ScaffoldSection,
  ScaffoldSectionContent,
  ScaffoldSectionDetail,
} from '@/components/layouts/Scaffold'
import { InlineLink } from '@/components/ui/InlineLink'
import { TextConfirmModal } from '@/components/ui/TextConfirmModalWrapper'
import { useDpaRequestMutation } from '@/data/documents/dpa-request-mutation'
import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'
import { t as $t } from '@/lib/i18n'
import { useProfile } from '@/lib/profile'
import { useTrack } from '@/lib/telemetry/track'

export const DPA = () => {
  const { profile } = useProfile()
  const { data: organization } = useSelectedOrganizationQuery()
  const slug = organization?.slug

  const [isOpen, setIsOpen] = useState(false)

  const track = useTrack()
  const { mutate: requestDpa, isPending: isRequesting } = useDpaRequestMutation({
    onSuccess: () => {
      toast.success($t('DPA request sent successfully'))
      setIsOpen(false)
    },
  })

  const onConfirmRequest = async () => {
    if (!slug) return toast.error($t('Organization not found.'))
    if (!profile?.primary_email) return toast.error($t('Profile email not found.'))
    requestDpa({ recipient_email: profile?.primary_email, slug: slug })
  }

  return (
    <>
      <ScaffoldSection className="py-12">
        <ScaffoldSectionDetail>
          <h4 className="mb-5">{$t('Data Processing Addendum (DPA)')}</h4>
          <div className="space-y-2 text-sm text-foreground-light [&_p]:m-0">
            <p>
              {$t(
                'All organizations can sign our Data Processing Addendum ("DPA") as part of their GDPR compliance.'
              )}
            </p>
            <p>
              {$t('You can review a static PDF version of our latest DPA document')}{' '}
              <InlineLink
                href="https://supabase.com/downloads/docs/Supabase+DPA+260601.pdf"
                onClick={() => track('dpa_pdf_opened', { source: 'studio' })}
              >
                here
              </InlineLink>
              .
            </p>
          </div>
        </ScaffoldSectionDetail>
        <ScaffoldSectionContent>
          <div className="@lg:flex items-center justify-center h-full">
            <Button
              onClick={() => {
                setIsOpen(true)
                track('dpa_request_button_clicked')
              }}
              variant="default"
            >
              {$t('Request DPA')}
            </Button>
          </div>
        </ScaffoldSectionContent>
      </ScaffoldSection>

      <TextConfirmModal
        visible={isOpen}
        title={$t('Request executable DPA to sign')}
        loading={isRequesting}
        confirmPlaceholder="Enter your email address"
        confirmString={profile?.primary_email ?? ''}
        confirmLabel="Send DPA request"
        errorMessage="Email must match your account email."
        onCancel={() => setIsOpen(false)}
        onConfirm={() => onConfirmRequest()}
      >
        <div className="space-y-2 text-sm">
          <p>
            {$t(
              'To make the DPA legally binding, you need to sign and complete the details through a PandaDoc document that we prepare.'
            )}
          </p>
          <p>
            {$t(
              'Please enter your email address to request an executable version of the DPA. You will receive a document link via PandaDoc in the next 24 hours.'
            )}
          </p>
          <p>
            {$t(
              "Once signed, the DPA will be considered executed and you'll be notified of any future updates via this email."
            )}
          </p>
        </div>
      </TextConfirmModal>
    </>
  )
}
