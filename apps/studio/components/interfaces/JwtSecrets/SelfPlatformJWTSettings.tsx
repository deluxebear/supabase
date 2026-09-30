import { PermissionAction } from '@supabase/shared-types/out/constants'
import { useParams } from 'common'
import { Card, CardContent } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { Input } from 'ui-patterns/DataInputs/Input'
import { FormLayout } from 'ui-patterns/form/Layout/FormLayout'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import { JWTConfigurationForm } from './JWTConfigurationForm'
import { AlertError } from '@/components/ui/AlertError'
import { DocsButton } from '@/components/ui/DocsButton'
import { NoPermission } from '@/components/ui/NoPermission'
import { useProjectPostgrestConfigQuery } from '@/data/config/project-postgrest-config-query'
import { useAsyncCheckPermissions } from '@/hooks/misc/useCheckPermissions'
import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

export const SelfPlatformJWTSettings = () => {
  const { ref: projectRef } = useParams()
  const { can: canReadSecrets, isSuccess: isPermissionsLoaded } = useAsyncCheckPermissions(
    PermissionAction.SECRETS_READ,
    'projects'
  )
  const { data, error, isPending, isError } = useProjectPostgrestConfigQuery(
    { projectRef },
    { enabled: isPermissionsLoaded && canReadSecrets, refetchInterval: 15_000 }
  )

  if (!isPermissionsLoaded) return <GenericSkeletonLoader />
  if (!canReadSecrets) return <NoPermission resourceText="access your project's JWT secret" />
  if (isPending) return <GenericSkeletonLoader />
  if (isError)
    return (
      <AlertError
        projectRef={projectRef}
        error={error}
        subject={$t('Failed to retrieve JWT settings')}
      />
    )

  return (
    <div className="space-y-4">
      <Admonition type="note" title={$t('Manage JWT keys in your Supabase deployment')}>
        <p>
          {$t(
            'Asymmetric JWT signing key creation, rotation, and revocation must be configured in your Supabase deployment. Legacy HS256 configuration can be applied through the Fleet Agent.'
          )}
        </p>
        <DocsButton href={`${DOCS_URL}/guides/self-hosting/self-hosted-auth-keys`} />
      </Admonition>
      {data?.jwt_secret ? (
        <Card>
          <CardContent className="pt-6">
            <FormLayout
              layout="flex-row-reverse"
              label={$t('JWT secret')}
              id="managed-jwt-secret"
              description={$t('The legacy HS256 JWT secret registered for this project.')}
            >
              <Input id="managed-jwt-secret" copy reveal readOnly value={data?.jwt_secret} />
            </FormLayout>
          </CardContent>
        </Card>
      ) : (
        <Admonition type="note" title={$t('No legacy JWT secret registered')}>
          {$t(
            'This project has no legacy HS256 JWT secret in its registered configuration. Check the signing key configuration in your Supabase deployment.'
          )}
        </Admonition>
      )}
      {projectRef && <JWTConfigurationForm projectRef={projectRef} />}
    </div>
  )
}
