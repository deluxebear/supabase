import { t as $t } from '@/lib/i18n'

export const SqlEditorManualSavePreview = () => {
  return (
    <div className="space-y-4">
      <p className="text-sm text-foreground-light">
        {$t('Switch the SQL Editor from autosaving every edit to saving only when you ask it to.')}
      </p>
      <div className="space-y-2">
        <p className="text-sm">{$t('Enabling this preview will:')}</p>
        <ul className="list-disc pl-6 text-sm text-foreground-light space-y-1">
          <li>{$t('Stop auto-saving snippet edits as you type')}</li>
          <li>{$t('Add a Save button next to Run in the SQL Editor toolbar')}</li>
          <li>{$t('Let you save with Cmd+S at any time')}</li>
        </ul>
      </div>
      <p className="text-sm text-foreground-light">
        {$t(
          'Manual saving is becoming the default for the SQL Editor. This preview can no longer be turned off. To opt into manual saving before the change reaches your account, enable this preview.'
        )}
      </p>
    </div>
  )
}
