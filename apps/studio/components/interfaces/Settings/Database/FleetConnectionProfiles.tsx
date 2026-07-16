import { useParams } from 'common'
import { Badge } from 'ui'
import {
  PageSection,
  PageSectionContent,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'
import { ShimmeringLoader } from 'ui-patterns/ShimmeringLoader'

import { AlertError } from '@/components/ui/AlertError'
import { useConnectionProfilesQuery } from '@/data/database/connection-profiles-query'
import { t as $t } from '@/lib/i18n'

const PROFILE_LABELS = {
  direct: 'Direct',
  transaction: 'Transaction pooler',
  session: 'Session pooler',
  read_only: 'Read-only',
} as const

export const FleetConnectionProfiles = () => {
  const { ref: projectRef } = useParams()
  const { data, error, isPending } = useConnectionProfilesQuery({ projectRef })

  return (
    <PageSection id="fleet-connection-profiles">
      <PageSectionMeta>
        <PageSectionSummary>
          <PageSectionTitle>{$t('Connection profiles')}</PageSectionTitle>
        </PageSectionSummary>
      </PageSectionMeta>
      <PageSectionContent>
        {isPending ? (
          <ShimmeringLoader />
        ) : error ? (
          <AlertError error={error} subject={$t('Failed to load connection profiles')} />
        ) : (
          <div className="divide-y rounded-md border">
            {data?.profiles.map((profile) => (
              <div
                key={profile.id}
                className="grid gap-3 px-4 py-3 text-sm md:grid-cols-[180px_1fr]"
              >
                <div className="flex items-center gap-2 font-medium">
                  {$t(PROFILE_LABELS[profile.id])}
                  {profile.poolMode !== 'direct' && <Badge>Supavisor</Badge>}
                </div>
                <dl className="grid gap-x-4 gap-y-1 text-foreground-light sm:grid-cols-2">
                  <div>
                    <dt className="inline text-foreground-lighter">{$t('Host')}: </dt>
                    <dd className="inline font-mono">{`${profile.host}:${profile.port}`}</dd>
                  </div>
                  <div>
                    <dt className="inline text-foreground-lighter">{$t('Database')}: </dt>
                    <dd className="inline font-mono">{profile.database}</dd>
                  </div>
                  <div>
                    <dt className="inline text-foreground-lighter">{$t('User')}: </dt>
                    <dd className="inline font-mono">{profile.user}</dd>
                  </div>
                  <div>
                    <dt className="inline text-foreground-lighter">{$t('TLS mode')}: </dt>
                    <dd className="inline font-mono">{profile.tlsMode}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
        )}
      </PageSectionContent>
    </PageSection>
  )
}
