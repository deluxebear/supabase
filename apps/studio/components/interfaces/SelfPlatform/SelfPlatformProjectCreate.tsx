import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/router'
import { useMemo, useState } from 'react'
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
  Tabs_Shadcn_,
  TabsContent_Shadcn_,
  TabsList_Shadcn_,
  TabsTrigger_Shadcn_,
} from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import * as z from 'zod'

import { useOrgProjectsInfiniteQuery } from '@/data/projects/org-projects-infinite-query'
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

const refSchema = z
  .string()
  .regex(REF_REGEX, 'Lowercase letters, digits and hyphens; 3-30 chars; starts with a letter')
  .refine((r) => r !== 'default', '"default" is reserved')

const quickSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(64),
  ref: refSchema,
  hostRef: z.string().min(1),
})

const attachSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(64),
  ref: refSchema,
  dbHost: z.string().min(1, 'Database host is required'),
  dbPort: z.coerce.number().int().min(1).max(65535).default(5432),
  dbName: z.string().default('postgres'),
  dbUser: z.string().default('supabase_admin'),
  dbUserReadonly: z.string().default('supabase_read_only_user'),
  dbPass: z.string().min(1, 'Database password is required'),
  kongUrl: z.string().url('Must be a URL (the browser-facing gateway)'),
  restUrl: z.string().optional(),
  anonKey: z.string().min(1, 'Required'),
  serviceKey: z.string().min(1, 'Required'),
  jwtSecret: z.string().min(1, 'Required'),
  publishableKey: z.string().optional(),
  secretKey: z.string().optional(),
  logflareUrl: z.string().optional(),
  logflareToken: z.string().optional(),
})

export const SelfPlatformProjectCreate = () => {
  const router = useRouter()
  const slug = typeof router.query.slug === 'string' ? router.query.slug : 'default'
  const [tab, setTab] = useState<'quick' | 'attach'>('quick')

  const { data: projectPages } = useOrgProjectsInfiniteQuery({ slug })
  const hostOptions = useMemo(() => {
    const all = projectPages?.pages.flatMap((p) => p.projects) ?? []
    // stack_kind is a self-platform compat extra on top of the cloud schema type
    return all.filter((p) => (p as { stack_kind?: string }).stack_kind === 'external')
  }, [projectPages])

  const { mutate: createProject, isPending } = useSelfPlatformProjectCreateMutation({
    onSuccess: (res) => {
      toast.success($t('Project created'))
      router.push(`/project/${res.ref}`)
    },
  })

  const quickForm = useForm<z.infer<typeof quickSchema>>({
    resolver: zodResolver(quickSchema),
    defaultValues: { name: '', ref: '', hostRef: 'default' },
  })
  const attachForm = useForm<z.infer<typeof attachSchema>>({
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
      kongUrl: '',
      restUrl: '',
      anonKey: '',
      serviceKey: '',
      jwtSecret: '',
      publishableKey: '',
      secretKey: '',
      logflareUrl: '',
      logflareToken: '',
    },
  })

  // [self-platform] Only called from nameAndRefFields below, where `form` is
  // always narrowed to `typeof quickForm` (attachForm is cast to that shape
  // at its call site) — typing the union of both forms here would make
  // getFieldState/setValue uncallable (their signatures don't unify).
  const syncRef = (form: typeof quickForm, name: string) => {
    if (!form.getFieldState('ref').isDirty) {
      form.setValue('ref', refSuggestion(name))
    }
  }

  const onQuickSubmit = quickForm.handleSubmit((values) =>
    createProject({ mode: 'shared-db', organizationSlug: slug, ...values })
  )
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

  const nameAndRefFields = (form: typeof quickForm) => (
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
      <Tabs_Shadcn_ value={tab} onValueChange={(v) => setTab(v as 'quick' | 'attach')}>
        <TabsList_Shadcn_>
          <TabsTrigger_Shadcn_ value="quick">{$t('Quick create')}</TabsTrigger_Shadcn_>
          <TabsTrigger_Shadcn_ value="attach">{$t('Attach existing stack')}</TabsTrigger_Shadcn_>
        </TabsList_Shadcn_>

        <TabsContent_Shadcn_ value="quick">
          <Form {...quickForm}>
            <form onSubmit={onQuickSubmit} noValidate className="flex flex-col gap-4 pt-4">
              <p className="text-sm text-foreground-light">
                {$t(
                  'Creates a new database on an existing stack. The gateway, API keys and auth are shared with the host stack.'
                )}
              </p>
              {nameAndRefFields(quickForm)}
              <FormField
                control={quickForm.control}
                name="hostRef"
                render={({ field }) => (
                  <FormItemLayout name="hostRef" layout="vertical" label={$t('Host stack')}>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {hostOptions.map((p) => (
                          <SelectItem key={p.ref} value={p.ref}>
                            {p.name} ({p.ref})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItemLayout>
                )}
              />
              <div className="flex justify-end">
                <Button type="submit" loading={isPending}>
                  {$t('Create project')}
                </Button>
              </div>
            </form>
          </Form>
        </TabsContent_Shadcn_>

        <TabsContent_Shadcn_ value="attach">
          <Form {...attachForm}>
            <form onSubmit={onAttachSubmit} noValidate className="flex flex-col gap-4 pt-4">
              <p className="text-sm text-foreground-light">
                {$t(
                  'Registers a fully independent stack. The connection is verified before the project is created.'
                )}
              </p>
              {nameAndRefFields(attachForm as unknown as typeof quickForm)}
              {(
                [
                  ['dbHost', $t('Database host'), 'text'],
                  ['dbPass', $t('Database password'), 'password'],
                  ['kongUrl', $t('Gateway URL'), 'text'],
                  ['anonKey', $t('Anon key'), 'password'],
                  ['serviceKey', $t('Service role key'), 'password'],
                  ['jwtSecret', $t('JWT secret'), 'password'],
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
                      ['restUrl', $t('REST URL (derived from the gateway URL if empty)'), 'text'],
                      ['publishableKey', $t('Publishable key'), 'password'],
                      ['secretKey', $t('Secret key'), 'password'],
                      ['logflareUrl', $t('Logflare URL'), 'text'],
                      ['logflareToken', $t('Logflare token'), 'password'],
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
                </CollapsibleContent>
              </Collapsible>
              <div className="flex justify-end">
                <Button type="submit" loading={isPending}>
                  {$t('Verify connection and attach')}
                </Button>
              </div>
            </form>
          </Form>
        </TabsContent_Shadcn_>
      </Tabs_Shadcn_>
    </div>
  )
}
