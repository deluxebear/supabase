import { zodResolver } from '@hookform/resolvers/zod'
import { PermissionAction } from '@supabase/shared-types/out/constants'
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
    kongUrl: z.string().trim().url($t('Must be a URL (the browser-facing gateway)')),
    restUrl: z.string().trim().url($t('Must be a URL')),
    dbPass: z.string(),
    anonKey: z.string(),
    serviceKey: z.string(),
    jwtSecret: z.string(),
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
    anonKey: '',
    serviceKey: '',
    jwtSecret: '',
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
  }
}

export const SelfPlatformConnectionPanel = () => {
  const { data: project } = useSelectedProjectQuery()
  const { can: canUpdate } = useAsyncCheckPermissions(PermissionAction.UPDATE, 'projects')
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

  const buildPayload = (values: FormValues): SelfPlatformProjectUpdateVariables | undefined => {
    const dirty = form.formState.dirtyFields
    const connection: SelfPlatformConnectionPatch = {}
    if (dirty.dbHost) connection.dbHost = values.dbHost
    if (dirty.dbPort) connection.dbPort = values.dbPort
    if (dirty.dbName) connection.dbName = values.dbName
    if (dirty.dbUser) connection.dbUser = values.dbUser
    if (dirty.dbUserReadonly) connection.dbUserReadonly = values.dbUserReadonly
    if (dirty.kongUrl) connection.kongUrl = values.kongUrl
    if (dirty.restUrl) connection.restUrl = values.restUrl
    if (values.dbPass !== '') connection.dbPass = values.dbPass
    if (values.anonKey !== '') connection.anonKey = values.anonKey
    if (values.serviceKey !== '') connection.serviceKey = values.serviceKey
    if (values.jwtSecret !== '') connection.jwtSecret = values.jwtSecret
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

    const payload: SelfPlatformProjectUpdateVariables = { ref: project.ref }
    if (!isSharedDb && Object.keys(connection).length > 0) payload.connection = connection
    if (Object.keys(logflare).length > 0) payload.logflare = logflare
    if (Object.keys(metrics).length > 0) payload.metrics = metrics
    if (
      payload.connection === undefined &&
      payload.logflare === undefined &&
      payload.metrics === undefined
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

  const textField = (name: keyof FormValues, label: string) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItemLayout name={name} layout="vertical" label={label}>
          <FormControl>
            <Input {...field} value={String(field.value ?? '')} disabled={!canUpdate} />
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
              disabled={!canUpdate}
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
        {serverError !== undefined && (
          <Alert variant="warning">
            <WarningIcon />
            <AlertDescription>{serverError}</AlertDescription>
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
                {textField('dbHost', $t('Database host'))}
                {textField('dbPort', $t('Database port'))}
                {textField('dbName', $t('Database name'))}
                {textField('dbUser', $t('Database user'))}
                {textField('dbUserReadonly', $t('Read-only database user'))}
                {textField('kongUrl', $t('API gateway URL'))}
                {textField('restUrl', $t('REST URL'))}
                {secretField('dbPass', $t('Database password'))}
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
