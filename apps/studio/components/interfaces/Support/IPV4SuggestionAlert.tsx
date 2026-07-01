import { ExternalLink, HelpCircle } from 'lucide-react'
import Link from 'next/link'
import { Alert, AlertDescription, AlertTitle, Button } from 'ui'

import { t as $t } from '@/lib/i18n'

export const IPV4SuggestionAlert = () => {
  return (
    <Alert variant="default">
      <HelpCircle strokeWidth={2} />
      <AlertTitle>{$t('Connection issues?')}</AlertTitle>
      <AlertDescription className="grid gap-3">
        <p>
          {$t(
            'Having trouble connecting to your project? It could be related to our migration from PGBouncer and IPv4.'
          )}
        </p>
        <p>
          {$t(
            "Please review this GitHub discussion. It's up to date and covers many frequently asked questions."
          )}
        </p>
        <p>
          <Button asChild variant="default" icon={<ExternalLink strokeWidth={1.5} />}>
            <Link
              target="_blank"
              rel="noreferrer"
              href="https://github.com/orgs/supabase/discussions/17817"
            >
              {$t('PGBouncer and IPv4 Deprecation #17817')}
            </Link>
          </Button>
        </p>
      </AlertDescription>
    </Alert>
  )
}
