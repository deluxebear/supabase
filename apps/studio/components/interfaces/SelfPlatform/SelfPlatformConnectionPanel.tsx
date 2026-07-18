import { zodResolver } from '@hookform/resolvers/zod'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Form,
  FormControl,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  WarningIcon,
} from 'ui'
import ConfirmationModal from 'ui-patterns/Dialogs/ConfirmationModal'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import {
  PageSection,
  PageSectionContent,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'
import * as z from 'zod'

import {
  findProjectCapability,
  projectCapabilitiesQueryOptions,
} from '@/data/projects/project-capabilities-query'
import {
  useSelfPlatformProjectUpdateMutation,
  type SelfPlatformConnectionPatch,
  type SelfPlatformProjectBlock,
  type SelfPlatformProjectUpdateVariables,
} from '@/data/projects/self-platform-project-update-mutation'
import { useAsyncCheckPermissions } from '@/hooks/misc/useCheckPermissions'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { t as $t } from '@/lib/i18n'

// [self-platform] M6.1 T3: connection-config edit panel (spec §7). Secrets
// are write-only: inputs always start empty; leave blank to keep the stored
// value. Nullable fields clear via explicit checkboxes, never by emptying an
// input (spec D5). shared-db rows only expose the logflare and metrics
// sections, not the connection block (D1).
function buildConnectionEditSchema() {
  return z.object({
    dbHost: z.string().trim().min(1, $t('Database host is required')),
    dbPort: z.coerce.number().int().min(1).max(65535),
    dbName: z.string().trim().min(1, $t('Required')),
    dbUser: z.string().trim().min(1, $t('Required')),
    dbUserReadonly: z.string().trim().min(1, $t('Required')),
    kongUrl: z.union([z.literal(''), z.string().trim().url($t('Must be a URL'))]),
    restUrl: z.union([z.literal(''), z.string().trim().url($t('Must be a URL'))]),
    dbPass: z.string(),
    dbPassReadonly: z.string(),
    dbPassReadonlyClear: z.boolean(),
    anonKey: z.string(),
    serviceKey: z.string(),
    jwtSecret: z.string(),
    keyMode: z.enum(['legacy-jwt', 'asymmetric-jwks', 'mixed']),
    tlsMode: z.enum(['disable', 'prefer', 'require', 'verify-ca', 'verify-full']),
    tlsCaReference: z.string(),
    tlsCaReferenceClear: z.boolean(),
    publishableKey: z.string(),
    publishableKeyClear: z.boolean(),
    secretKey: z.string(),
    secretKeyClear: z.boolean(),
    logflareUrl: z.union([z.literal(''), z.string().trim().url($t('Must be a URL'))]),
    logflareUrlClear: z.boolean(),
    logflareToken: z.string(),
    logflareTokenClear: z.boolean(),
    metricsUrl: z.union([z.literal(''), z.string().trim().url($t('Must be a URL'))]),
    metricsUrlClear: z.boolean(),
    metricsToken: z.string(),
    metricsTokenClear: z.boolean(),
    container: z.string(),
    containerClear: z.boolean(),
    k8sNamespace: z.string(),
    k8sPodSelector: z.string(),
    k8sClear: z.boolean(),
  })
}
type FormValues = z.infer<ReturnType<typeof buildConnectionEditSchema>>

function buildDefaults(sp: SelfPlatformProjectBlock): FormValues {
  return {
    dbHost: sp.db_host,
    dbPort: sp.db_port,
    dbName: sp.db_name,
    dbUser: sp.db_user,
    dbUserReadonly: sp.db_user_readonly,
    kongUrl: sp.kong_url,
    restUrl: sp.rest_url,
    dbPass: '',
    dbPassReadonly: '',
    dbPassReadonlyClear: false,
    anonKey: '',
    serviceKey: '',
    jwtSecret: '',
    keyMode: sp.key_mode ?? sp.attachment?.keyMode ?? 'legacy-jwt',
    tlsMode: sp.tls_mode ?? 'prefer',
    tlsCaReference: sp.tls_ca_reference ?? '',
    tlsCaReferenceClear: false,
    publishableKey: '',
    publishableKeyClear: false,
    secretKey: '',
    secretKeyClear: false,
    logflareUrl: sp.logflare_url ?? '',
    logflareUrlClear: false,
    logflareToken: '',
    logflareTokenClear: false,
    metricsUrl: sp.metrics_url ?? '',
    metricsUrlClear: false,
    metricsToken: '',
    metricsTokenClear: false,
    container: sp.container_name ?? '',
    containerClear: false,
    k8sNamespace: sp.k8s_namespace ?? '',
    k8sPodSelector: sp.k8s_pod_selector ?? '',
    k8sClear: false,
  }
}

export const SelfPlatformConnectionPanel = () => {
  const { data: project } = useSelectedProjectQuery()
  const { can: canUpdate } = useAsyncCheckPermissions(PermissionAction.UPDATE, 'projects')
  const capabilities = useQuery(projectCapabilitiesQueryOptions({ projectRef: project?.ref }))
  const [pendingPayload, setPendingPayload] = useState<SelfPlatformProjectUpdateVariables>()
  const [serverError, setServerError] = useState<string>()

  const selfPlatform = (
    project as unknown as { self_platform?: SelfPlatformProjectBlock } | undefined
  )?.self_platform

  const schema = useMemo(() => buildConnectionEditSchema(), [])
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: selfPlatform ? buildDefaults(selfPlatform) : undefined,
  })
  useEffect(() => {
    // Dirty-gated: a background refetch (window refocus, 5s COMING_UP poll)
    // must not wipe in-progress edits; post-save the mutation's onSuccess
    // resets dirty state first, so fresh server values land here.
    if (selfPlatform && !form.formState.isDirty) form.reset(buildDefaults(selfPlatform))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfPlatform])

  const { mutate: updateProject, isPending } = useSelfPlatformProjectUpdateMutation({
    onSuccess: () => {
      setServerError(undefined)
      setPendingPayload(undefined)
      form.reset(form.getValues())
      toast.success($t('Connection configuration saved'))
    },
    onError: (err) => {
      setServerError(err.message)
      setPendingPayload(undefined)
    },
  })

  // Registry-row-less 'default' (env fallback) has nothing to edit.
  if (project === undefined || selfPlatform === undefined) return null

  const isSharedDb = selfPlatform.stack_kind === 'shared-db'
  const sharedChildren = selfPlatform.shared_children
  const connectionCapability = findProjectCapability(capabilities.data, 'project.connection.update')
  const canUpdateConnection = canUpdate && connectionCapability?.state === 'available'

  const buildPayload = (values: FormValues): SelfPlatformProjectUpdateVariables | undefined => {
    const dirty = form.formState.dirtyFields
    const connection: SelfPlatformConnectionPatch = {}
    if (values.dbPass !== '') connection.dbPass = values.dbPass
    if (values.dbPassReadonlyClear) connection.dbPassReadonly = null
    else if (values.dbPassReadonly !== '') connection.dbPassReadonly = values.dbPassReadonly
    if (values.anonKey !== '') connection.anonKey = values.anonKey
    if (values.serviceKey !== '') connection.serviceKey = values.serviceKey
    if (values.jwtSecret !== '') connection.jwtSecret = values.jwtSecret
    if (dirty.keyMode) {
      connection.keyMode = values.keyMode
      if (values.keyMode === 'asymmetric-jwks' && values.jwtSecret === '') {
        connection.jwtSecret = null
      }
    }
    if (dirty.tlsMode) connection.tlsMode = values.tlsMode
    if (values.tlsCaReferenceClear) connection.tlsCaReference = null
    else if (dirty.tlsCaReference && values.tlsCaReference !== '') {
      connection.tlsCaReference = values.tlsCaReference
    }
    if (values.publishableKeyClear) connection.publishableKey = null
    else if (values.publishableKey !== '') connection.publishableKey = values.publishableKey
    if (values.secretKeyClear) connection.secretKey = null
    else if (values.secretKey !== '') connection.secretKey = values.secretKey

    const logflare: { url?: string | null; token?: string | null } = {}
    if (values.logflareUrlClear) logflare.url = null
    else if (dirty.logflareUrl && values.logflareUrl !== '') logflare.url = values.logflareUrl
    if (values.logflareTokenClear) logflare.token = null
    else if (values.logflareToken !== '') logflare.token = values.logflareToken

    const metrics: { url?: string | null; token?: string | null } = {}
    if (values.metricsUrlClear) metrics.url = null
    else if (dirty.metricsUrl && values.metricsUrl !== '') metrics.url = values.metricsUrl
    if (values.metricsTokenClear) metrics.token = null
    else if (values.metricsToken !== '') metrics.token = values.metricsToken

    let container: string | null | undefined
    if (values.containerClear) container = null
    else if (dirty.container && values.container !== '') container = values.container

    let k8s: { namespace: string | null; pod_selector: string | null } | null | undefined
    if (values.k8sClear) k8s = null
    else if (dirty.k8sNamespace || dirty.k8sPodSelector) {
      k8s = {
        namespace: values.k8sNamespace !== '' ? values.k8sNamespace : null,
        pod_selector: values.k8sPodSelector !== '' ? values.k8sPodSelector : null,
      }
    }

    const payload: SelfPlatformProjectUpdateVariables = { ref: project.ref }
    if (!isSharedDb && Object.keys(connection).length > 0) payload.connection = connection
    if (Object.keys(logflare).length > 0) payload.logflare = logflare
    if (Object.keys(metrics).length > 0) payload.metrics = metrics
    if (container !== undefined) payload.container = container
    if (k8s !== undefined) payload.k8s = k8s
    if (
      payload.connection === undefined &&
      payload.logflare === undefined &&
      payload.metrics === undefined &&
      payload.container === undefined &&
      payload.k8s === undefined
    )
      return undefined
    return payload
  }

  const onSubmit = form.handleSubmit((values) => {
    const payload = buildPayload(values)
    if (payload === undefined) {
      toast($t('No changes to save'))
      return
    }
    if (payload.connection !== undefined && sharedChildren.length > 0) {
      setPendingPayload(payload) // confirm propagation first (spec D7)
      return
    }
    updateProject(payload)
  })

  const secretPlaceholder = $t('Saved — leave blank to keep the current value')
  const setBadge = (isSet: boolean) =>
    isSet ? (
      <Badge variant="success">{$t('Configured')}</Badge>
    ) : (
      <Badge variant="warning">{$t('Not configured')}</Badge>
    )

  const textField = (name: keyof FormValues, label: string, description?: string) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItemLayout name={name} layout="vertical" label={label} description={description}>
          <FormControl>
            <Input
              {...field}
              value={String(field.value ?? '')}
              disabled={!canUpdate || (!isSharedDb && !canUpdateConnection)}
            />
          </FormControl>
        </FormItemLayout>
      )}
    />
  )

  const registryField = (
    name: 'dbHost' | 'dbPort' | 'dbName' | 'dbUser' | 'dbUserReadonly' | 'kongUrl' | 'restUrl',
    label: string
  ) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItemLayout
          name={name}
          layout="vertical"
          label={label}
          description={$t('Managed by the versioned Fleet endpoint registry')}
        >
          <FormControl>
            <Input {...field} value={String(field.value)} disabled />
          </FormControl>
        </FormItemLayout>
      )}
    />
  )

  const secretField = (name: keyof FormValues, label: string, badge?: boolean) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItemLayout
          name={name}
          layout="vertical"
          label={
            badge === undefined ? (
              label
            ) : (
              <span className="flex items-center gap-2">
                {label} {setBadge(badge)}
              </span>
            )
          }
        >
          <FormControl>
            <Input
              {...field}
              value={String(field.value ?? '')}
              type="password"
              placeholder={secretPlaceholder}
              disabled={!canUpdateConnection}
            />
          </FormControl>
        </FormItemLayout>
      )}
    />
  )

  const clearCheckbox = (name: keyof FormValues, label: string) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <label className="flex items-center gap-2 text-sm text-foreground-light">
          <Checkbox
            checked={field.value === true}
            onCheckedChange={(v) => field.onChange(v === true)}
            disabled={!canUpdate}
          />
          {label}
        </label>
      )}
    />
  )

  return (
    <PageSection id="connection-config">
      <PageSectionMeta>
        <PageSectionSummary>
          <PageSectionTitle>{$t('Connection configuration')}</PageSectionTitle>
        </PageSectionSummary>
      </PageSectionMeta>

      <PageSectionContent>
        {!canUpdate && (
          <Alert>
            <AlertDescription>
              {$t('You need additional permissions to update connection configuration.')}
            </AlertDescription>
          </Alert>
        )}
        {canUpdate && !canUpdateConnection && (
          <Alert variant="warning">
            <WarningIcon />
            <AlertDescription>
              {connectionCapability?.blockers[0]?.message ??
                $t('Connection updates are unavailable until the project capability is verified.')}
            </AlertDescription>
          </Alert>
        )}
        {serverError !== undefined && (
          <Alert variant="warning">
            <WarningIcon />
            <AlertDescription className="whitespace-pre-wrap break-words">
              {serverError}
            </AlertDescription>
          </Alert>
        )}

        <Form {...form}>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            {isSharedDb ? (
              <Alert>
                <AlertDescription>
                  {$t('Connection fields are managed by the host stack {{hostRef}}.', {
                    hostRef: selfPlatform.host_ref ?? '',
                  })}{' '}
                  {selfPlatform.host_ref !== null && (
                    <Link
                      className="underline"
                      href={`/project/${selfPlatform.host_ref}/settings/general`}
                    >
                      {$t('Open host project settings')}
                    </Link>
                  )}
                </AlertDescription>
              </Alert>
            ) : (
              <>
                {sharedChildren.length > 0 && (
                  <Alert>
                    <AlertDescription>
                      {$t(
                        'Connection changes are synced to the shared-db projects cloned from this stack: {{refs}}',
                        { refs: sharedChildren.join(', ') }
                      )}
                    </AlertDescription>
                  </Alert>
                )}
                {registryField('dbHost', $t('Public database host'))}
                {registryField('dbPort', $t('Public database port'))}
                {registryField('dbName', $t('Database name'))}
                {registryField('dbUser', $t('Database user'))}
                {registryField('dbUserReadonly', $t('Read-only database user'))}
                {registryField('kongUrl', $t('Public API gateway URL'))}
                {registryField('restUrl', $t('Public REST URL'))}
                <FormField
                  control={form.control}
                  name="keyMode"
                  render={({ field }) => (
                    <FormItemLayout name="keyMode" layout="vertical" label={$t('API key mode')}>
                      <FormControl>
                        <Select
                          value={field.value}
                          onValueChange={field.onChange}
                          disabled={!canUpdateConnection}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="legacy-jwt">{$t('Legacy JWT')}</SelectItem>
                            <SelectItem value="asymmetric-jwks">{$t('Asymmetric JWKS')}</SelectItem>
                            <SelectItem value="mixed">{$t('Mixed migration')}</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormControl>
                    </FormItemLayout>
                  )}
                />
                <FormField
                  control={form.control}
                  name="tlsMode"
                  render={({ field }) => (
                    <FormItemLayout
                      name="tlsMode"
                      layout="vertical"
                      label={$t('Database TLS mode')}
                      description={$t(
                        'Saving re-runs attachment preflight. Prefer/require need a Postgres that accepts SSL; local Compose stacks usually use disable.'
                      )}
                    >
                      <FormControl>
                        <Select
                          value={field.value}
                          onValueChange={field.onChange}
                          disabled={!canUpdateConnection}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {['disable', 'prefer', 'require', 'verify-ca', 'verify-full'].map(
                              (mode) => (
                                <SelectItem key={mode} value={mode}>
                                  {mode}
                                </SelectItem>
                              )
                            )}
                          </SelectContent>
                        </Select>
                      </FormControl>
                    </FormItemLayout>
                  )}
                />
                {textField('tlsCaReference', $t('TLS CA reference'))}
                {clearCheckbox('tlsCaReferenceClear', $t('Clear the stored TLS CA reference'))}
                {secretField('dbPass', $t('Database password'))}
                {secretField(
                  'dbPassReadonly',
                  $t('Read-only database password'),
                  selfPlatform.secrets_set.db_pass_readonly
                )}
                {clearCheckbox(
                  'dbPassReadonlyClear',
                  $t('Use the primary database password for read-only access')
                )}
                {secretField('anonKey', $t('Anon key'))}
                {secretField('serviceKey', $t('Service role key'))}
                {secretField('jwtSecret', $t('JWT secret'))}
                <Collapsible>
                  <CollapsibleTrigger asChild>
                    <Button variant="default" type="button">
                      {$t('Optional keys')}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="flex flex-col gap-4 pt-4">
                    {secretField(
                      'publishableKey',
                      $t('Publishable key'),
                      selfPlatform.secrets_set.publishable_key
                    )}
                    {clearCheckbox('publishableKeyClear', $t('Clear the stored publishable key'))}
                    {secretField(
                      'secretKey',
                      $t('Secret key'),
                      selfPlatform.secrets_set.secret_key
                    )}
                    {clearCheckbox('secretKeyClear', $t('Clear the stored secret key'))}
                  </CollapsibleContent>
                </Collapsible>
              </>
            )}

            {isSharedDb && (
              <Alert>
                <AlertDescription>
                  {$t(
                    'Analytics configured here reads the host stack log stream — logs are stack-scoped and cannot be filtered per project.'
                  )}
                </AlertDescription>
              </Alert>
            )}
            {textField('logflareUrl', $t('Logflare URL'))}
            {clearCheckbox('logflareUrlClear', $t('Clear the stored Logflare URL'))}
            {secretField(
              'logflareToken',
              $t('Logflare token'),
              selfPlatform.secrets_set.logflare_token
            )}
            {clearCheckbox('logflareTokenClear', $t('Clear the stored Logflare token'))}

            {isSharedDb && (
              <Alert>
                <AlertDescription>
                  {$t(
                    'Host metrics configured here read the host stack — CPU/RAM/Disk are stack-scoped, not per project.'
                  )}
                </AlertDescription>
              </Alert>
            )}
            {textField('metricsUrl', $t('Metrics URL'))}
            {clearCheckbox('metricsUrlClear', $t('Clear the stored metrics URL'))}
            {secretField(
              'metricsToken',
              $t('Metrics token'),
              selfPlatform.secrets_set.metrics_token
            )}
            {clearCheckbox('metricsTokenClear', $t('Clear the stored metrics token'))}
            {textField(
              'container',
              $t('Postgres container name'),
              $t(
                'Must match the container name reported by cAdvisor (e.g. supabase-db). Leave blank to use host-level metrics.'
              )
            )}
            {clearCheckbox('containerClear', $t('Clear the stored container name'))}
            {selfPlatform.stack_kind === 'k8s' && (
              <>
                {textField(
                  'k8sNamespace',
                  $t('Pod namespace'),
                  $t('The Kubernetes namespace of the Postgres pod (e.g. supabase).')
                )}
                {textField(
                  'k8sPodSelector',
                  $t('Pod name'),
                  $t(
                    'Exact Postgres pod name (e.g. supabase-db-0). Network is read from the pod sandbox; CPU/RAM from the container above.'
                  )
                )}
                {clearCheckbox('k8sClear', $t('Clear the stored k8s identity'))}
              </>
            )}
            {isSharedDb && (
              <Alert>
                <AlertDescription>
                  {$t(
                    "Shared-db projects report the shared Postgres container — CPU/RAM/network are the container's, not per logical database."
                  )}
                </AlertDescription>
              </Alert>
            )}

            <div>
              <Button type="submit" loading={isPending} disabled={!canUpdate}>
                {$t('Save connection configuration')}
              </Button>
            </div>
          </form>
        </Form>
      </PageSectionContent>

      <ConfirmationModal
        visible={pendingPayload !== undefined}
        loading={isPending}
        title={$t('Sync shared projects?')}
        confirmLabel={$t('Save and sync')}
        onCancel={() => setPendingPayload(undefined)}
        onConfirm={() => {
          if (pendingPayload !== undefined) updateProject(pendingPayload)
        }}
      >
        <p className="text-sm text-foreground-light">
          {$t(
            'These connection changes will also be applied to the shared-db projects cloned from this stack: {{refs}}',
            { refs: sharedChildren.join(', ') }
          )}
        </p>
      </ConfirmationModal>
    </PageSection>
  )
}
