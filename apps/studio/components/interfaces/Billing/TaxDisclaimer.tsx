import { cn } from 'ui'

import { t as $t } from '@/lib/i18n'

interface TaxDisclaimerProps {
  className?: string
}

export const TaxDisclaimer = ({ className }: TaxDisclaimerProps) => {
  return (
    <p className={cn('text-xs text-foreground-muted', className)}>
      {$t('Prices shown do not include applicable taxes.')}
    </p>
  )
}
