import { Alert, AlertDescription, AlertTitle, CriticalIcon } from 'ui'
import {
  PageSection,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'

import { DeleteAccountButton } from './DeleteAccountButton'
import { t as $t } from '@/lib/i18n'

export const AccountDeletion = () => {
  return (
    <PageSection>
      <PageSectionMeta>
        <PageSectionSummary>
          <PageSectionTitle>{$t('Danger zone')}</PageSectionTitle>
          <PageSectionDescription>
            {$t('Permanently delete your Supabase account and data.')}
          </PageSectionDescription>
        </PageSectionSummary>
      </PageSectionMeta>
      <PageSectionContent>
        <Alert variant="destructive">
          <CriticalIcon />
          <AlertTitle>{$t('Request for account deletion')}</AlertTitle>
          <AlertDescription>
            {$t(
              'Deleting your account is permanent and cannot be undone. Your data will be deleted within 30 days, but we may retain some metadata and logs for longer where required or permitted by law.'
            )}
          </AlertDescription>
          <AlertDescription className="mt-3">
            <DeleteAccountButton />
          </AlertDescription>
        </Alert>
      </PageSectionContent>
    </PageSection>
  )
}
