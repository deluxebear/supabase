import { useParams } from 'common'
import { Admonition } from 'ui-patterns/Admonition'
import { TimestampInfo } from 'ui-patterns/TimestampInfo'

import { ContactSupportButton } from '@/components/ui/AlertError'
import { t as $t } from '@/lib/i18n'

export const SuspensionNotice = ({ suspendedAt }: { suspendedAt?: string | null }) => {
  const { ref } = useParams()

  return (
    <Admonition
      layout="horizontal"
      className="mb-4"
      type="warning"
      title={$t('Supabase has suspended Realtime for this project')}
      description={
        <>
          {$t('Suspended since')}{' '}
          <TimestampInfo
            className="text-sm"
            labelFormat="DD MMM HH:mm:ss"
            utcTimestamp={suspendedAt ?? ''}
          />{' '}
          {$t('due to suspected unusual or excessive usage.')} <br />
          {$t('Contact support for details or to restore access.')}
        </>
      }
      actions={
        <ContactSupportButton
          projectRef={ref}
          subject="Enquiry on realtime suspension for project"
        />
      }
    />
  )
}
