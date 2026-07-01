import { useParams } from 'common'
import Image from 'next/image'

import { InlineLink } from '@/components/ui/InlineLink'
import { BASE_PATH } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

export const RLSTesterPreview = () => {
  const { ref } = useParams()

  return (
    <div className="flex flex-col gap-2">
      <p className="text-foreground-light text-sm mb-4">
        {$t(
          "Verify if your RLS policies have been set up properly by running queries as a specific user. While role impersonation isn't a new feature on the dashboard, we've built a dedicated UI for this which will also show what policies are evaluated for the query."
        )}
      </p>
      <Image
        src={`${BASE_PATH}/img/previews/rls-tester-preview.png`}
        width={1296}
        height={900}
        quality={100}
        alt="rls-tester-preview"
        className="rounded-sm border"
      />
      <div className="space-y-2 mt-4!">
        <p className="text-sm">{$t('Enabling this preview will:')}</p>
        <ul className="list-disc pl-6 text-sm text-foreground-light space-y-1">
          <li>
            {$t('Show the "Test" button on the')}{' '}
            <InlineLink href={`/project/${ref}/database/policies`}>
              {$t('Database Policies page')}
            </InlineLink>
          </li>
        </ul>
      </div>
    </div>
  )
}
