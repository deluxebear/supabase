import Link from 'next/link'

import { t as $t } from '@/lib/i18n'

export const ObservabilityOverviewFooter = () => {
  return (
    <div className="pt-4 pb-12 flex items-center justify-center">
      <p className="text-sm text-foreground-light">
        <Link
          href="https://supabase.com/docs/guides/troubleshooting"
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground underline underline-offset-2 decoration-foreground-muted hover:decoration-foreground transition-all"
        >
          {$t('View our troubleshooting guides')}
        </Link>{' '}
        {$t('for solutions to common Supabase issues.')}{' '}
      </p>
    </div>
  )
}
