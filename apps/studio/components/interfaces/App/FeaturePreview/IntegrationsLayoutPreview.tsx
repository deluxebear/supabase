import Image from 'next/image'
import { BASE_PATH } from 'ui-patterns/CommandMenu/prepackaged/shared/constants'

import { t as $t } from '@/lib/i18n'

export const IntegrationsLayoutPreview = () => (
  <div>
    <p className="text-sm text-foreground-light mb-4">
      {$t('Install Dashboard Integrations in a single click and try the new layout.')}
    </p>

    <Image
      alt={$t('integrations layout preview')}
      src={`${BASE_PATH}/img/previews/integrations-layout-preview.png`}
      width={1296}
      height={900}
      className="rounded-sm border"
    />
  </div>
)
