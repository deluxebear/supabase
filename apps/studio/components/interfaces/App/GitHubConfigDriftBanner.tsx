import { useParams } from 'common'
import { AnimatePresence } from 'framer-motion'
import Link from 'next/link'

import { HeaderBanner } from '../Organization/HeaderBanner'
import { useSelectedGitHubConfigDrift } from '@/hooks/misc/useGitHubConfigDrift'
import { t as $t } from '@/lib/i18n'

export function GitHubConfigDriftBanner() {
  const { ref } = useParams()
  const { hasConfigurationIssues, summary } = useSelectedGitHubConfigDrift()

  const driftCount = summary.driftedFields.length
  const settingsLabel = `${driftCount} managed ${driftCount === 1 ? 'setting differs' : 'settings differ'}`

  return (
    <AnimatePresence initial={false}>
      {hasConfigurationIssues && ref && (
        <HeaderBanner
          key="github-config-drift-banner"
          variant="warning"
          title={$t('Code configuration needs attention')}
          description={
            <>
              {$t('Current environment values are active;')} {settingsLabel}.{' '}
              <Link href={`/project/${ref}/settings/code-configuration`}>
                {$t('Review configuration')}
              </Link>
            </>
          }
        />
      )}
    </AnimatePresence>
  )
}
