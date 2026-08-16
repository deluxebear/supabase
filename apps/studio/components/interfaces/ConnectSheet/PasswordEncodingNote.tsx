import { InlineLink } from '@/components/ui/InlineLink'
import { SPECIAL_SYMBOLS_IN_PASSWORDS_DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

export const PasswordEncodingNote = () => {
  return (
    <p className="text-sm text-foreground-lighter mb-1">
      {$t('If your database password contains special characters,')}{' '}
      <InlineLink href={SPECIAL_SYMBOLS_IN_PASSWORDS_DOCS_URL}>percent-encode</InlineLink>{' '}
      {$t('them in the connection string.')}
    </p>
  )
}
