import { Alert, AlertDescription, AlertTitle, Button, CriticalIcon } from 'ui'

import { t as $t } from '@/lib/i18n'

interface ViewAppSheetDangerZoneProps {
  onDelete: () => void
}

export function ViewAppSheetDangerZone({ onDelete }: ViewAppSheetDangerZoneProps) {
  return (
    <div className="px-5 sm:px-6 py-6 space-y-3">
      <h3 className="text-sm font-medium text-foreground">{$t('Danger Zone')}</h3>
      <Alert variant="destructive">
        <CriticalIcon />
        <AlertTitle>{$t('Delete app')}</AlertTitle>
        <AlertDescription>
          {$t('Permanently delete this app and all its installations.')}
        </AlertDescription>
        <div className="mt-2">
          <Button variant="danger" onClick={onDelete}>
            {$t('Delete app')}
          </Button>
        </div>
      </Alert>
    </div>
  )
}
