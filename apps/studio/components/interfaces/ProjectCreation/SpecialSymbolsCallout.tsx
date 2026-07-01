import { InlineLink } from '@/components/ui/InlineLink'
import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

export const SpecialSymbolsCallout = () => {
  return (
    <p className="mb-2">
      {$t('Note: If using the Postgres connection string, you will need to')}{' '}
      <InlineLink href={`${DOCS_URL}/guides/database/postgres/roles#special-symbols-in-passwords`}>
        percent-encode
      </InlineLink>{' '}
      {$t('the password')}
    </p>
  )
}
