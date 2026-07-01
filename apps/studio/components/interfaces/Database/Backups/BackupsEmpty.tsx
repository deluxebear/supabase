import { DatabaseBackup } from 'lucide-react'
import { EmptyStatePresentational } from 'ui-patterns/EmptyStatePresentational'

import { t as $t } from '@/lib/i18n'

export const BackupsEmpty = () => {
  return (
    <EmptyStatePresentational
      icon={DatabaseBackup}
      title={$t('No backups yet')}
      description={$t('Check again tomorrow.')}
    />
  )
}
