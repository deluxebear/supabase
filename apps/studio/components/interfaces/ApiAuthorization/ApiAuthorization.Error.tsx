import Link from 'next/link'
import type { ReactNode } from 'react'
import { Button } from 'ui'
import { Admonition } from 'ui-patterns/admonition'

import { InterstitialLayout, SupabaseLogo } from '@/components/layouts/InterstitialLayout'
import type { ResourceError } from '@/data/api-authorization/api-authorization-query'
import { t as $t } from '@/lib/i18n'

export interface ApiAuthorizationErrorScreenProps {
  error: ResourceError | undefined
}

export function ApiAuthorizationErrorScreen({
  error,
}: ApiAuthorizationErrorScreenProps): ReactNode {
  return (
    <InterstitialLayout logo={<SupabaseLogo />} title={$t('Unable to load authorization')}>
      <div className="flex flex-col gap-3 px-6 pb-6">
        <Admonition
          type="warning"
          description={
            <>
              {$t('Retry the authorization request from the requesting app.')}
              {error && (
                <span className="mt-1 block text-foreground-lighter">
                  {$t('Error:')} {error.message}
                </span>
              )}
            </>
          }
        />
        <Button variant="default" block asChild>
          <Link href="/">{$t('Back to dashboard')}</Link>
        </Button>
      </div>
    </InterstitialLayout>
  )
}
