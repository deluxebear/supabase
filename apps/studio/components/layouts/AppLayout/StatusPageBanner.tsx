import { useStatusPageBannerVisibility } from './useStatusPageBannerVisibility'
import { HeaderBanner } from '@/components/interfaces/Organization/HeaderBanner'
import { InlineLink } from '@/components/ui/InlineLink'
import { t as $t } from '@/lib/i18n'

const BANNER_DESCRIPTION = (
  <>
    {$t('Follow the')}{' '}
    <InlineLink href="https://status.supabase.com">{$t('status page')}</InlineLink>{' '}
    {$t('for updates')}
  </>
)

/**
 * Used to display ongoing incidents
 */
export const StatusPageBanner = () => {
  const banner = useStatusPageBannerVisibility()

  if (!banner) return null

  return (
    <HeaderBanner
      variant="warning"
      title={banner.title}
      description={BANNER_DESCRIPTION}
      onDismiss={banner.dismiss}
    />
  )
}
