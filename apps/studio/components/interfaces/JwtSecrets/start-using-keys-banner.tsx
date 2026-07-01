import { Import } from 'lucide-react'
import { Button } from 'ui'

import { FeatureBanner } from '@/components/ui/FeatureBanner'
import { t as $t } from '@/lib/i18n'

export const StartUsingJwtSigningKeysBanner = ({
  onClick,
  isLoading,
}: {
  onClick: () => void
  isLoading: boolean
}) => {
  return (
    <FeatureBanner bgAlt>
      <div className="flex flex-col gap-0 z-2">
        <p className="text-sm text-foreground">{$t('Start using JWT signing keys')}</p>
        <p className="text-sm text-foreground-lighter lg:max-w-sm 2xl:max-w-none">
          {$t(
            "Right now your project is using the legacy JWT secret. To start taking advantage of the new JWT signing keys, migrate your project's secret to the new set up."
          )}
        </p>
        <div className="mt-4">
          <Button variant="primary" icon={<Import />} onClick={onClick} loading={isLoading}>
            {$t('Migrate JWT secret')}
          </Button>
        </div>
      </div>
    </FeatureBanner>
  )
}
