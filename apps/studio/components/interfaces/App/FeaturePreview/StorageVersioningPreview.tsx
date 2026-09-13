import { t as $t } from '@/lib/i18n'

export const StorageVersioningPreview = () => {
  return (
    <div className="space-y-4">
      <p className="text-sm text-foreground-light">
        {$t(
          "Keep previous copies of a file when it's overwritten or deleted, and set a lifecycle policy that expires them automatically."
        )}
      </p>
      <div className="space-y-2">
        <p className="text-sm">{$t('Enabling this preview will:')}</p>
        <ul className="list-disc pl-6 text-sm text-foreground-light space-y-1">
          <li>
            {$t('Add object versioning and lifecycle policy settings to the bucket settings')}
          </li>
          <li>{$t('Show a version history for each file in the file preview panel')}</li>
          <li>{$t('Allow soft-deleting and restoring files')}</li>
          <li>{$t('Break down retained version storage on the organization usage page')}</li>
        </ul>
      </div>
      <p className="text-sm text-foreground-light">
        {$t('Versioning is in')} <em>{$t('Private Alpha')}</em>{' '}
        {$t('and is off for every bucket by default until you turn it on.')}
      </p>
    </div>
  )
}
