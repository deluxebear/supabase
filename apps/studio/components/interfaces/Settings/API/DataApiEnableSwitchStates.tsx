import { AlertCircle } from 'lucide-react'
import { Alert, AlertTitle, CardContent } from 'ui'
import { ShimmeringLoader } from 'ui-patterns/ShimmeringLoader'

import { t as $t } from '@/lib/i18n'

export const DataApiEnableSwitchLoading = () => (
  <CardContent className="space-y-2">
    <ShimmeringLoader />
    <ShimmeringLoader className="w-3/4" delayIndex={1} />
  </CardContent>
)

export const DataApiEnableSwitchError = () => (
  <Alert variant="destructive">
    <AlertCircle size={16} />
    <AlertTitle>{$t('Failed to retrieve Data API settings')}</AlertTitle>
  </Alert>
)
