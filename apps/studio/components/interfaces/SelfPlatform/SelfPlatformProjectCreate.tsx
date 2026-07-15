import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/router'
import { useMemo } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import {
  Button,
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
} from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import * as z from 'zod'

import {
  useSelfPlatformProjectCreateMutation,
  type SelfPlatformExternalConnection,
} from '@/data/projects/self-platform-project-create-mutation'
import { t as $t } from '@/lib/i18n'

const REF_REGEX = /^[a-z][a-z0-9-]{2,29}$/

export function refSuggestion(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
  if (!slug) return ''
  return /^[a-z]/.test(slug) ? slug : `p-${slug}`.slice(0, 30)
}

function buildRefSchema() {
  return z
    .string()
    .regex(REF_REGEX, $t('Lowercase letters, digits and hyphens; 3-30 chars; starts with a letter'))
    .refine((r) => r !== 'default', $t('"default" is reserved'))
}

function buildAttachSchema() {
  return z
    .object({
      name: z.string().min(1, $t('Project name is required')).max(64),
      ref: buildRefSchema(),
      dbHost: z.string().min(1, $t('Database host is required')),
      dbPort: z.coerce.number().int().min(1).max(65535).default(5432),
      dbName: z.string().default('postgres'),
      dbUser: z.string().default('supabase_admin'),
      dbUserReadonly: z.string().default('supabase_read_only_user'),
      dbPass: z.string().min(1, $t('Database password is required')),
      dbPassReadonly: z.string().optional(),
      kongUrl: z.string().url($t('Must be a URL (the browser-facing gateway)')),
      restUrl: z.string().optional(),
      keyMode: z.enum(['legacy-jwt', 'asymmetric-jwks', 'mixed']),
      tlsMode: z.enum(['disable', 'prefer', 'require', 'verify-ca', 'verify-full']),
      tlsCaReference: z.string().optional(),
      anonKey: z.string().optional(),
      serviceKey: z.string().optional(),
      jwtSecret: z.string().optional(),
      publishableKey: z.string().optional(),
      secretKey: z.string().optional(),
      logflareUrl: z.string().optional(),
      logflareToken: z.string().optional(),
    })
    .superRefine((value, context) => {
      if (value.keyMode !== 'asymmetric-jwks') {
        for (const field of ['anonKey', 'serviceKey', 'jwtSecret'] as const) {
          if (!value[field]) {
            context.addIssue({ code: 'custom', path: [field], message: $t('Required') })
          }
        }
      }
      if (value.keyMode !== 'legacy-jwt') {
        for (const field of ['publishableKey', 'secretKey'] as const) {
          if (!value[field]) {
            context.addIssue({ code: 'custom', path: [field], message: $t('Required') })
          }
        }
      }
      if (value.keyMode === 'asymmetric-jwks' && value.jwtSecret) {
        context.addIssue({
          code: 'custom',
          path: ['jwtSecret'],
          message: $t('Leave JWT secret empty for asymmetric keys'),
        })
      }
    })
}

type AttachFormValues = z.infer<ReturnType<typeof buildAttachSchema>>

export const SelfPlatformProjectCreate = () => {
  const router = useRouter()
  const slug = typeof router.query.slug === 'string' ? router.query.slug : 'default'

  const { mutate: createProject, isPending } = useSelfPlatformProjectCreateMutation({
    onSuccess: (res) => {
      toast.success($t('Project created'))
      router.push(`/project/${res.ref}`)
    },
  })

  const attachSchema = useMemo(() => buildAttachSchema(), [])

  const attachForm = useForm<AttachFormValues>({
    resolver: zodResolver(attachSchema),
    defaultValues: {
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
      anonKey: '',
      serviceKey: '',
      jwtSecret: '',
      keyMode: 'legacy-jwt',
      tlsMode: 'prefer',
      tlsCaReference: '',
      publishableKey: '',
      secretKey: '',
      logflareUrl: '',
      logflareToken: '',
    },
  })

  const syncRef = (form: typeof attachForm, name: string) => {
    if (!form.getFieldState('ref').isDirty) {
      form.setValue('ref', refSuggestion(name))
    }
  }
  const keyMode = attachForm.watch('keyMode')

  const onAttachSubmit = attachForm.handleSubmit(({ name, ref, ...c }) =>
    createProject({
      mode: 'external',
      organizationSlug: slug,
      name,
      ref,
      connection: Object.fromEntries(
        Object.entries(c).filter(([, v]) => v !== '' && v !== undefined)
      ) as unknown as SelfPlatformExternalConnection,
    })
  )

  const nameAndRefFields = (form: typeof attachForm) => (
    <>
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItemLayout name="name" layout="vertical" label={$t('Project name')}>
            <FormControl>
              <Input
                {...field}
                onChange={(e) => {
                  field.onChange(e)
                  syncRef(form, e.target.value)
                }}
              />
            </FormControl>
          </FormItemLayout>
        )}
      />
      <FormField
        control={form.control}
        name="ref"
        render={({ field }) => (
          <FormItemLayout
            name="ref"
            layout="vertical"
            label={$t('Project ref')}
            description={$t('Unique identifier used in URLs and the registry')}
          >
            <FormControl>
              <Input {...field} />
            </FormControl>
          </FormItemLayout>
        )}
      />
    </>
  )

  return (
    <div className="mx-auto w-full max-w-2xl py-8 px-4 flex flex-col gap-6">
      <div>
        <h1 className="text-xl text-foreground">{$t('Create a new project')}</h1>
        <p className="text-sm text-foreground-light">
          {$t('Projects are registered in the platform registry and served by your own stacks.')}
        </p>
      </div>
      <Form {...attachForm}>
        <form onSubmit={onAttachSubmit} noValidate className="flex flex-col gap-4">
          <p className="text-sm text-foreground-light">
            {$t(
              'Registers a fully independent stack. The connection is verified before the project is created.'
            )}
          </p>
          {nameAndRefFields(attachForm)}
          <FormField
            control={attachForm.control}
            name="keyMode"
            render={({ field }) => (
              <FormItemLayout
                name="keyMode"
                layout="vertical"
                label={$t('API key mode')}
                description={$t('Choose the signing and API key model used by the target stack.')}
              >
                <FormControl>
                  <Select value={field.value} onValueChange={field.onChange}>
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
          {(
            [
              ['dbHost', $t('Database host'), 'text'],
              ['dbPass', $t('Database password'), 'password'],
              ['kongUrl', $t('Gateway URL'), 'text'],
              ...(keyMode === 'asymmetric-jwks'
                ? []
                : ([
                    ['anonKey', $t('Anon key'), 'password'],
                    ['serviceKey', $t('Service role key'), 'password'],
                    ['jwtSecret', $t('JWT secret'), 'password'],
                  ] as const)),
              ...(keyMode === 'legacy-jwt'
                ? []
                : ([
                    ['publishableKey', $t('Publishable key'), 'password'],
                    ['secretKey', $t('Secret key'), 'password'],
                  ] as const)),
            ] as const
          ).map(([key, label, type]) => (
            <FormField
              key={key}
              control={attachForm.control}
              name={key}
              render={({ field }) => (
                <FormItemLayout name={key} layout="vertical" label={label}>
                  <FormControl>
                    <Input {...field} type={type} />
                  </FormControl>
                </FormItemLayout>
              )}
            />
          ))}
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button variant="default" type="button">
                {$t('Optional settings')}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-4 pt-4">
              {(
                [
                  ['dbPort', $t('Database port'), 'text'],
                  ['dbName', $t('Database name'), 'text'],
                  ['dbUser', $t('Database user'), 'text'],
                  ['dbUserReadonly', $t('Read-only database user'), 'text'],
                  ['dbPassReadonly', $t('Read-only database password'), 'password'],
                  ['restUrl', $t('REST URL (derived from the gateway URL if empty)'), 'text'],
                  ['logflareUrl', $t('Logflare URL'), 'text'],
                  ['logflareToken', $t('Logflare token'), 'password'],
                  ['tlsCaReference', $t('TLS CA reference'), 'text'],
                ] as const
              ).map(([key, label, type]) => (
                <FormField
                  key={key}
                  control={attachForm.control}
                  name={key}
                  render={({ field }) => (
                    <FormItemLayout name={key} layout="vertical" label={label}>
                      <FormControl>
                        <Input {...field} value={String(field.value ?? '')} type={type} />
                      </FormControl>
                    </FormItemLayout>
                  )}
                />
              ))}
              <FormField
                control={attachForm.control}
                name="tlsMode"
                render={({ field }) => (
                  <FormItemLayout name="tlsMode" layout="vertical" label={$t('Database TLS mode')}>
                    <FormControl>
                      <Select value={field.value} onValueChange={field.onChange}>
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
            </CollapsibleContent>
          </Collapsible>
          <div className="flex justify-end">
            <Button type="submit" loading={isPending}>
              {$t('Verify connection and attach')}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  )
}
