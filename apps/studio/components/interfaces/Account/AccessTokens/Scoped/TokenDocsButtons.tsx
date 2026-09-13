import { DocsButton } from '@/components/ui/DocsButton'
import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

/** Docs links shown in the header of the scoped token sheets. */
export const TokenDocsButtons = () => {
  return (
    <div className="flex items-center gap-2">
      <DocsButton
        href={`${DOCS_URL}/guides/platform/personal-access-tokens`}
        topic="Personal access tokens"
        label={$t('Access tokens docs')}
      />
      <DocsButton
        href={`${DOCS_URL}/guides/platform/access-control`}
        topic="Access control"
        label={$t('Access control docs')}
      />
    </div>
  )
}
