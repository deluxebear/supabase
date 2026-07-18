import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { Check, Circle, Copy, ExternalLink, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  Form,
  FormControl,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'
import * as z from 'zod'

import { AlertError } from '@/components/ui/AlertError'
import { managementTargetsQueryOptions } from '@/data/organizations/management-targets-query'
import { useProjectAttachmentActivateMutation } from '@/data/projects/project-attachment-activate-mutation'
import { useProjectAttachmentRollbackMutation } from '@/data/projects/project-attachment-rollback-mutation'
import {
  useProjectEnrollmentTokenMutation,
  useProjectManagementBindMutation,
  useProjectManagementSyncMutation,
} from '@/data/projects/project-management-binding-mutations'
import { projectManagementBindingQueryOptions } from '@/data/projects/project-management-binding-query'
import {
  useSelfPlatformProjectCreateMutation,
  type SelfPlatformExternalConnection,
  type SelfPlatformProjectCreateResponse,
  type SelfPlatformPublicEndpoints,
} from '@/data/projects/self-platform-project-create-mutation'
import { t as $t } from '@/lib/i18n'

const REF_REGEX = /^[a-z][a-z0-9-]{2,29}$/
export const FLEET_ATTACH_DEFAULT_TLS_MODE = 'disable' as const

export function refSuggestion(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
  if (!slug) return ''
  return /^[a-z]/.test(slug) ? slug : `p-${slug}`.slice(0, 30)
}

const attachSchema = z
  .object({
    managementTargetId: z.string().uuid($t('Select a management target')),
    executionTarget: z.string().trim().min(1, $t('Execution target is required')).max(255),
    name: z.string().trim().min(1, $t('Project name is required')).max(64),
    ref: z
      .string()
      .regex(REF_REGEX, $t('Lowercase letters, digits and hyphens; 3-30 chars'))
      .refine((value) => value !== 'default', $t('"default" is reserved')),
    dbHost: z.string().trim().min(1, $t('Database host is required')),
    dbPort: z.coerce.number().int().min(1).max(65535),
    dbName: z.string().trim().min(1),
    dbUser: z.string().trim().min(1),
    dbUserReadonly: z.string().trim().min(1),
    dbPass: z.string().min(1, $t('Database password is required')),
    dbPassReadonly: z.string().optional(),
    kongUrl: z.string().url($t('Enter a valid internal gateway URL')),
    restUrl: z.string().optional(),
    keyMode: z.enum(['legacy-jwt', 'asymmetric-jwks', 'mixed']),
    tlsMode: z.enum(['disable', 'prefer', 'require', 'verify-ca', 'verify-full']),
    anonKey: z.string().optional(),
    serviceKey: z.string().optional(),
    jwtSecret: z.string().optional(),
    publishableKey: z.string().optional(),
    secretKey: z.string().optional(),
    publicApiUrl: z.string().url($t('Enter a valid public API URL')),
    publicDbHost: z.string().trim().min(1, $t('Public database host is required')),
    publicDirectPort: z.coerce.number().int().min(1).max(65535),
    publicTransactionPort: z.coerce.number().int().min(1).max(65535),
    publicSessionPort: z.coerce.number().int().min(1).max(65535),
    publicDbUser: z.string().trim().min(1),
    publicTenantId: z.string().trim().min(1),
  })
  .superRefine((value, context) => {
    if (value.keyMode !== 'asymmetric-jwks') {
      for (const field of ['anonKey', 'serviceKey', 'jwtSecret'] as const) {
        if (!value[field])
          context.addIssue({ code: 'custom', path: [field], message: $t('Required') })
      }
    }
    if (value.keyMode !== 'legacy-jwt') {
      for (const field of ['publishableKey', 'secretKey'] as const) {
        if (!value[field])
          context.addIssue({ code: 'custom', path: [field], message: $t('Required') })
      }
    }
  })

type AttachFormValues = z.infer<typeof attachSchema>
type EnrollmentToken = { token: string; expiresAt: string }

const bindingSchema = z.object({
  managementTargetId: z.string().uuid($t('Select a management target')),
  executionTarget: z.string().trim().min(1, $t('Execution target is required')).max(255),
})

type BindingFormValues = z.infer<typeof bindingSchema>

const stepLabels = [$t('Connect stack'), $t('Enroll Agent'), $t('Activate project')]

function StepIndicator({ current }: { current: number }) {
  return (
    <ol className="grid grid-cols-3 gap-2" aria-label={$t('Attachment progress')}>
      {stepLabels.map((label, index) => {
        const complete = index < current
        const active = index === current
        return (
          <li
            key={label}
            className="flex items-center gap-2 border-b pb-3 text-sm text-foreground-light"
            aria-current={active ? 'step' : undefined}
          >
            {complete ? (
              <Check size={16} className="text-brand" />
            ) : (
              <Circle size={16} className={active ? 'text-brand' : 'text-foreground-muted'} />
            )}
            <span className={active ? 'text-foreground' : undefined}>{label}</span>
          </li>
        )
      })}
    </ol>
  )
}

function StatusIcon({ status }: { status: 'pass' | 'fail' | 'warning' | 'unsupported' }) {
  if (status === 'pass') return <Check size={16} className="text-brand" />
  return <Circle size={16} className="text-warning" />
}

export const SelfPlatformProjectCreate = () => {
  const router = useRouter()
  const slug = typeof router.query.slug === 'string' ? router.query.slug : undefined
  const projectRef = typeof router.query.project === 'string' ? router.query.project : undefined
  const targets = useQuery(managementTargetsQueryOptions({ slug }))
  const binding = useQuery(projectManagementBindingQueryOptions({ projectRef }))
  const [staged, setStaged] = useState<SelfPlatformProjectCreateResponse>()
  const [token, setToken] = useState<EnrollmentToken>()
  const [serverError, setServerError] = useState<Error>()

  const activeTargets = useMemo(
    () => targets.data?.targets.filter((target) => target.state === 'active') ?? [],
    [targets.data]
  )
  const create = useSelfPlatformProjectCreateMutation({ onError: setServerError })
  const bind = useProjectManagementBindMutation({ onError: setServerError })
  const issue = useProjectEnrollmentTokenMutation({
    onSuccess: (data) => setToken(data),
    onError: setServerError,
  })
  const sync = useProjectManagementSyncMutation({ onError: setServerError })
  const activate = useProjectAttachmentActivateMutation({
    onSuccess: (data) => {
      toast.success($t('Project activated'))
      router.push(`/project/${data.projectRef}`)
    },
    onError: setServerError,
  })
  const rollback = useProjectAttachmentRollbackMutation({
    onSuccess: async () => {
      setStaged(undefined)
      setToken(undefined)
      toast.success($t('Staged attachment rolled back'))
      await router.replace(`/new/${slug}`)
    },
    onError: setServerError,
  })
  const form = useForm<AttachFormValues>({
    resolver: zodResolver(attachSchema),
    defaultValues: {
      managementTargetId: '',
      executionTarget: '',
      name: '',
      ref: '',
      dbHost: '',
      dbPort: 5432,
      dbName: 'postgres',
      dbUser: 'supabase_admin',
      dbUserReadonly: 'supabase_read_only_user',
      dbPass: '',
      dbPassReadonly: '',
      kongUrl: '',
      restUrl: '',
      keyMode: 'legacy-jwt',
      tlsMode: FLEET_ATTACH_DEFAULT_TLS_MODE,
      anonKey: '',
      serviceKey: '',
      jwtSecret: '',
      publishableKey: '',
      secretKey: '',
      publicApiUrl: '',
      publicDbHost: '',
      publicDirectPort: 5432,
      publicTransactionPort: 6543,
      publicSessionPort: 5432,
      publicDbUser: 'postgres',
      publicTenantId: '',
    },
  })
  const keyMode = form.watch('keyMode')
  const bindingForm = useForm<BindingFormValues>({
    resolver: zodResolver(bindingSchema),
    defaultValues: { managementTargetId: '', executionTarget: '' },
  })
  const currentStep = projectRef
    ? binding.data?.binding?.agentSessionState === 'online'
      ? 2
      : 1
    : 0

  useEffect(() => {
    if (!projectRef) return
    if (!bindingForm.getValues('executionTarget')) {
      bindingForm.setValue('executionTarget', `compose://${projectRef}`)
    }
    if (!bindingForm.getValues('managementTargetId') && activeTargets.length === 1) {
      bindingForm.setValue('managementTargetId', activeTargets[0].id)
    }
  }, [activeTargets, bindingForm, projectRef])

  const setWizardUrl = (ref: string, step: 'enroll' | 'activate') =>
    router.replace({ pathname: router.pathname, query: { slug, project: ref, step } }, undefined, {
      shallow: true,
    })

  const submit = form.handleSubmit(async (values) => {
    if (!slug) return
    setServerError(undefined)
    const apiUrl = values.publicApiUrl.replace(/\/$/, '')
    const connection = Object.fromEntries(
      Object.entries({
        dbHost: values.dbHost,
        dbPort: values.dbPort,
        dbName: values.dbName,
        dbUser: values.dbUser,
        dbUserReadonly: values.dbUserReadonly,
        dbPass: values.dbPass,
        dbPassReadonly: values.dbPassReadonly,
        kongUrl: values.kongUrl,
        restUrl: values.restUrl,
        keyMode: values.keyMode,
        tlsMode: values.tlsMode,
        anonKey: values.anonKey,
        serviceKey: values.serviceKey,
        jwtSecret: values.jwtSecret,
        publishableKey: values.publishableKey,
        secretKey: values.secretKey,
      }).filter(([, value]) => value !== '')
    ) as unknown as SelfPlatformExternalConnection
    const publicEndpoints: SelfPlatformPublicEndpoints = {
      apiUrl,
      restUrl: `${apiUrl}/rest/v1`,
      authUrl: `${apiUrl}/auth/v1`,
      storageUrl: `${apiUrl}/storage/v1`,
      realtimeUrl: `${apiUrl}/realtime/v1`,
      functionsUrl: `${apiUrl}/functions/v1`,
      s3Url: `${apiUrl}/storage/v1/s3`,
      directPostgres: {
        host: values.publicDbHost,
        port: values.publicDirectPort,
        database: values.dbName,
        user: values.publicDbUser,
        tlsMode: values.tlsMode,
      },
      supavisor: {
        host: values.publicDbHost,
        transactionPort: values.publicTransactionPort,
        sessionPort: values.publicSessionPort,
        database: values.dbName,
        user: values.publicDbUser,
        tenantId: values.publicTenantId,
        tlsMode: values.tlsMode,
      },
    }
    try {
      const result = await create.mutateAsync({
        mode: 'external',
        organizationSlug: slug,
        name: values.name,
        ref: values.ref,
        connection,
        attachmentMode: 'staged',
        publicEndpoints,
      })
      setStaged(result)
      bindingForm.reset({
        managementTargetId: values.managementTargetId,
        executionTarget: values.executionTarget,
      })
      await setWizardUrl(result.ref, 'enroll')
      await bind.mutateAsync({
        projectRef: result.ref,
        payload: {
          managementTargetId: values.managementTargetId,
          executionTarget: values.executionTarget,
          deploymentKind: 'compose',
          allowedCapabilityPrefixes: ['backup.', 'runtime.', 'database.', 'functions.'],
        },
      })
    } catch {
      // Mutation handlers render the actionable server error. A successfully
      // staged project remains validating and the binding can be retried.
    }
  })

  const retryBinding = bindingForm.handleSubmit(async (values) => {
    if (!projectRef) return
    setServerError(undefined)
    await bind.mutateAsync({
      projectRef,
      payload: {
        managementTargetId: values.managementTargetId,
        executionTarget: values.executionTarget,
        deploymentKind: 'compose',
        allowedCapabilityPrefixes: ['backup.', 'runtime.', 'database.', 'functions.'],
      },
    })
  })

  const copyToken = async () => {
    if (!token) return
    await navigator.clipboard.writeText(token.token)
    toast.success($t('Enrollment token copied'))
  }

  const field = (
    name: keyof AttachFormValues,
    label: string,
    description?: string,
    type: 'text' | 'password' | 'number' = 'text'
  ) => (
    <CardContent key={name}>
      <FormField
        control={form.control}
        name={name}
        render={({ field: input }) => (
          <FormItemLayout
            name={name}
            layout="flex-row-reverse"
            label={label}
            description={description}
          >
            <FormControl>
              <Input {...input} value={String(input.value ?? '')} type={type} />
            </FormControl>
          </FormItemLayout>
        )}
      />
    </CardContent>
  )

  return (
    <>
      <PageHeader size="default">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{$t('Attach Project')}</PageHeaderTitle>
            <PageHeaderDescription>
              {$t('Verify an independent stack, enroll its Agent, then activate it')}
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="default" className="space-y-6 pb-16">
        <StepIndicator current={currentStep} />
        {(targets.isError || binding.isError) && (
          <AlertError
            error={targets.error ?? binding.error}
            subject={$t('Failed to load attachment setup')}
          />
        )}
        {serverError && <AlertError error={serverError} subject={$t('Attachment step failed')} />}

        {!projectRef ? (
          activeTargets.length === 0 && targets.isSuccess ? (
            <Alert variant="warning">
              <AlertTitle>{$t('No active management target')}</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>{$t('Create a management target before attaching a stack.')}</p>
                <Button asChild type="button" variant="default" icon={<ExternalLink size={14} />}>
                  <Link href={`/org/${slug}/management-targets`}>
                    {$t('Open management targets')}
                  </Link>
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <Form {...form}>
              <form onSubmit={submit} className="space-y-6" noValidate>
                <Card>
                  <CardContent>
                    <FormField
                      control={form.control}
                      name="managementTargetId"
                      render={({ field: input }) => (
                        <FormItemLayout
                          name="managementTargetId"
                          layout="flex-row-reverse"
                          label={$t('Management target')}
                          description={$t(
                            'Trust boundary that issues the single-use enrollment token'
                          )}
                        >
                          <Select value={input.value} onValueChange={input.onChange}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder={$t('Select a management target')} />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {activeTargets.map((target) => (
                                <SelectItem key={target.id} value={target.id}>
                                  {target.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormItemLayout>
                      )}
                    />
                  </CardContent>
                  {field(
                    'executionTarget',
                    $t('Execution target'),
                    $t('For example compose://project-b')
                  )}
                  <CardContent>
                    <FormItemLayout
                      layout="flex-row-reverse"
                      label={$t('Deployment kind')}
                      description={$t('Fleet Attach currently supports independent Compose stacks')}
                    >
                      <Input value="compose" disabled />
                    </FormItemLayout>
                  </CardContent>
                </Card>

                <Card>
                  {field('name', $t('Project name'))}
                  <CardContent>
                    <FormField
                      control={form.control}
                      name="ref"
                      render={({ field: input }) => (
                        <FormItemLayout
                          name="ref"
                          layout="flex-row-reverse"
                          label={$t('Project ref')}
                          description={$t('Unique registry and URL identifier')}
                        >
                          <FormControl>
                            <Input {...input} />
                          </FormControl>
                        </FormItemLayout>
                      )}
                    />
                  </CardContent>
                </Card>

                <Card>
                  {field(
                    'dbHost',
                    $t('Internal database host'),
                    $t('Reachable from the Studio server')
                  )}
                  {field('dbPort', $t('Internal database port'), undefined, 'number')}
                  {field('dbName', $t('Database name'))}
                  {field('dbUser', $t('Database user'))}
                  {field('dbUserReadonly', $t('Read-only database user'))}
                  {field('dbPass', $t('Database password'), undefined, 'password')}
                  {field(
                    'dbPassReadonly',
                    $t('Read-only database password'),
                    $t('Optional'),
                    'password'
                  )}
                  {field(
                    'kongUrl',
                    $t('Internal gateway URL'),
                    $t('Used only for server-side preflight')
                  )}
                  {field(
                    'restUrl',
                    $t('Internal REST URL'),
                    $t('Derived from the gateway when empty')
                  )}
                </Card>

                <Card>
                  <CardContent>
                    <FormField
                      control={form.control}
                      name="keyMode"
                      render={({ field: input }) => (
                        <FormItemLayout layout="flex-row-reverse" label={$t('API key mode')}>
                          <Select value={input.value} onValueChange={input.onChange}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="legacy-jwt">{$t('Legacy JWT')}</SelectItem>
                              <SelectItem value="asymmetric-jwks">
                                {$t('Asymmetric JWKS')}
                              </SelectItem>
                              <SelectItem value="mixed">{$t('Mixed migration')}</SelectItem>
                            </SelectContent>
                          </Select>
                        </FormItemLayout>
                      )}
                    />
                  </CardContent>
                  {keyMode !== 'asymmetric-jwks' &&
                    field('anonKey', $t('Anon key'), undefined, 'password')}
                  {keyMode !== 'asymmetric-jwks' &&
                    field('serviceKey', $t('Service role key'), undefined, 'password')}
                  {keyMode !== 'asymmetric-jwks' &&
                    field('jwtSecret', $t('JWT secret'), undefined, 'password')}
                  {keyMode !== 'legacy-jwt' &&
                    field('publishableKey', $t('Publishable key'), undefined, 'password')}
                  {keyMode !== 'legacy-jwt' &&
                    field('secretKey', $t('Secret key'), undefined, 'password')}
                </Card>

                <Card>
                  {field('publicApiUrl', $t('Public API URL'), $t('Browser-facing base URL'))}
                  {field('publicDbHost', $t('Public database host'))}
                  {field('publicDirectPort', $t('Direct Postgres port'), undefined, 'number')}
                  {field(
                    'publicTransactionPort',
                    $t('Transaction pooler port'),
                    undefined,
                    'number'
                  )}
                  {field('publicSessionPort', $t('Session pooler port'), undefined, 'number')}
                  {field('publicDbUser', $t('Public database user'))}
                  {field('publicTenantId', $t('Supavisor tenant ID'))}
                  <CardFooter className="justify-end">
                    <Button
                      type="submit"
                      variant="primary"
                      loading={create.isPending || bind.isPending}
                    >
                      {$t('Run preflight and stage project')}
                    </Button>
                  </CardFooter>
                </Card>
              </form>
            </Form>
          )
        ) : (
          <div className="space-y-6">
            {staged?.preflight && (
              <Card>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h2 className="text-base text-foreground">{$t('Preflight report')}</h2>
                    <Badge>{staged.preflight.outcome}</Badge>
                  </div>
                  {staged.preflight.checks.map((check) => (
                    <div key={check.name} className="flex items-start gap-3 text-sm">
                      <StatusIcon status={check.status} />
                      <div>
                        <p className="text-foreground">{check.name}</p>
                        <p className="text-foreground-light">{check.message}</p>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-base text-foreground">{$t('Agent enrollment')}</h2>
                    <p className="text-sm text-foreground-light">
                      {$t('Issue one token, enroll the Agent, and wait for an online heartbeat.')}
                    </p>
                  </div>
                  <Badge>{binding.data?.binding?.agentSessionState ?? 'not enrolled'}</Badge>
                </div>
                {binding.data?.binding ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      loading={issue.isPending}
                      onClick={() => issue.mutate({ projectRef })}
                    >
                      {$t('Issue single-use token')}
                    </Button>
                    <Button
                      type="button"
                      variant="default"
                      loading={sync.isPending}
                      onClick={() => sync.mutate({ projectRef })}
                    >
                      {$t('Refresh Agent status')}
                    </Button>
                  </div>
                ) : binding.isLoading || bind.isPending ? (
                  <p className="flex items-center gap-2 text-sm text-foreground-light">
                    <Loader2 size={14} className="animate-spin" />{' '}
                    {$t('Loading management binding...')}
                  </p>
                ) : (
                  <Form {...bindingForm}>
                    <form onSubmit={retryBinding} className="space-y-4" noValidate>
                      <Alert variant="warning">
                        <AlertTitle>{$t('Management binding incomplete')}</AlertTitle>
                        <AlertDescription>
                          {$t(
                            'The verified project remains staged. Retry the management binding or roll back the staged attachment.'
                          )}
                        </AlertDescription>
                      </Alert>
                      <FormField
                        control={bindingForm.control}
                        name="managementTargetId"
                        render={({ field: input }) => (
                          <FormItemLayout
                            name="managementTargetId"
                            layout="flex-row-reverse"
                            label={$t('Management target')}
                          >
                            <Select value={input.value} onValueChange={input.onChange}>
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue placeholder={$t('Select a management target')} />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {activeTargets.map((target) => (
                                  <SelectItem key={target.id} value={target.id}>
                                    {target.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </FormItemLayout>
                        )}
                      />
                      <FormField
                        control={bindingForm.control}
                        name="executionTarget"
                        render={({ field: input }) => (
                          <FormItemLayout
                            name="executionTarget"
                            layout="flex-row-reverse"
                            label={$t('Execution target')}
                          >
                            <FormControl>
                              <Input {...input} />
                            </FormControl>
                          </FormItemLayout>
                        )}
                      />
                      <Button type="submit" variant="default" loading={bind.isPending}>
                        {$t('Retry management binding')}
                      </Button>
                    </form>
                  </Form>
                )}
                {token && (
                  <Alert>
                    <AlertTitle>{$t('Single-use enrollment token')}</AlertTitle>
                    <AlertDescription className="space-y-3">
                      <p>
                        {$t('This token is shown once and expires at')}{' '}
                        {new Date(token.expiresAt).toLocaleString()}.
                      </p>
                      <div className="flex gap-2">
                        <Input value={token.token} readOnly className="font-mono" />
                        <Button
                          type="button"
                          variant="default"
                          icon={<Copy size={14} />}
                          onClick={copyToken}
                        >
                          {$t('Copy token')}
                        </Button>
                      </div>
                    </AlertDescription>
                  </Alert>
                )}
              </CardContent>
              <CardFooter className="justify-between">
                <Button
                  type="button"
                  variant="warning"
                  loading={rollback.isPending}
                  onClick={() => {
                    setServerError(undefined)
                    rollback.mutate({ projectRef, organizationSlug: slug })
                  }}
                >
                  {$t('Roll back staged attachment')}
                </Button>
                <div className="flex items-center gap-3">
                  <p className="text-xs text-foreground-muted">
                    {$t('Activation does not start until you confirm it.')}
                  </p>
                  <Button
                    type="button"
                    variant="primary"
                    loading={activate.isPending}
                    disabled={binding.data?.binding?.agentSessionState !== 'online'}
                    onClick={() => {
                      setServerError(undefined)
                      void setWizardUrl(projectRef, 'activate')
                      activate.mutate({ projectRef })
                    }}
                  >
                    {$t('Confirm and activate project')}
                  </Button>
                </div>
              </CardFooter>
            </Card>
          </div>
        )}
      </PageContainer>
    </>
  )
}
