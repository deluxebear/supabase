import { zodResolver } from '@hookform/resolvers/zod'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import { useParams } from 'common'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import {
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
  Switch,
  Textarea,
} from 'ui'
import { Admonition } from 'ui-patterns/admonition'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import {
  PageSection,
  PageSectionContent,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'
import { z } from 'zod'

import {
  useDatabaseSecurityQuery,
  useRotateDatabasePasswordMutation,
  useUpdateDatabaseSecurityMutation,
} from '@/data/database/database-security-query'
import { useAsyncCheckPermissions } from '@/hooks/misc/useCheckPermissions'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'

const settingsSchema = z
  .object({
    sslEnforced: z.boolean(),
    caReference: z.string().max(512),
    allowedCidrs: z.string(),
    defaultPoolSize: z.coerce.number().int().min(1).max(1000),
    maxClientConnections: z.coerce.number().int().min(10).max(100000),
  })
  .refine((value) => !value.sslEnforced || value.caReference.trim().length > 0, {
    path: ['caReference'],
    message: 'A TLS CA reference is required when SSL enforcement is enabled',
  })

const passwordSchema = z.object({
  role: z.enum(['primary', 'read-only']),
  newPassword: z.string().min(12, 'Use at least 12 characters').max(256),
})

type SettingsValues = z.infer<typeof settingsSchema>
type PasswordValues = z.infer<typeof passwordSchema>

function parseList(value: string) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export const FleetDatabaseSecurity = () => {
  const { ref } = useParams()
  const { data: project } = useSelectedProjectQuery()
  const { can: canUpdate } = useAsyncCheckPermissions(PermissionAction.UPDATE, 'projects', {
    resource: { project_id: project?.id },
  })
  const { data: policy, isPending, error, refetch } = useDatabaseSecurityQuery(ref)
  const update = useUpdateDatabaseSecurityMutation()
  const rotate = useRotateDatabasePasswordMutation()
  const settingsForm = useForm<SettingsValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      sslEnforced: false,
      caReference: '',
      allowedCidrs: '',
      defaultPoolSize: 15,
      maxClientConnections: 200,
    },
  })
  const passwordForm = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { role: 'primary', newPassword: '' },
  })

  useEffect(() => {
    if (!policy) return
    settingsForm.reset({
      sslEnforced: policy.ssl.enforced,
      caReference: policy.ssl.caReference,
      allowedCidrs: policy.network.allowedCidrs.join('\n'),
      defaultPoolSize: policy.pooler.defaultPoolSize,
      maxClientConnections: policy.pooler.maxClientConnections,
    })
  }, [policy, settingsForm])

  if (isPending) return <GenericSkeletonLoader />
  if (error || !policy) {
    return (
      <Admonition
        type="destructive"
        title="Unable to load database security settings"
        description={
          error instanceof Error ? error.message : 'The database security policy is unavailable.'
        }
      >
        <Button type="button" onClick={() => refetch()}>
          Retry
        </Button>
      </Admonition>
    )
  }

  const saveSettings = (values: SettingsValues) => {
    if (!ref) return
    update.mutate({
      projectRef: ref,
      expectedGeneration: policy.generation,
      policy: {
        ssl: { enforced: values.sslEnforced, caReference: values.caReference.trim() },
        network: { allowedCidrs: parseList(values.allowedCidrs) },
        pooler: {
          defaultPoolSize: values.defaultPoolSize,
          maxClientConnections: values.maxClientConnections,
        },
      },
    })
  }

  const rotatePassword = (values: PasswordValues) => {
    if (!ref) return
    rotate.mutate(
      { projectRef: ref, expectedGeneration: policy.generation, ...values },
      { onSuccess: () => passwordForm.reset({ role: values.role, newPassword: '' }) }
    )
  }

  return (
    <>
      {policy.state !== 'ready' && (
        <Admonition
          type={policy.state === 'failed' ? 'destructive' : 'warning'}
          title={
            policy.state === 'failed'
              ? 'The last change was rolled back'
              : 'Database settings are being applied'
          }
          description={policy.errorCode ?? 'Health verification is still in progress.'}
        />
      )}
      <PageSection id="fleet-database-security">
        <PageSectionMeta>
          <PageSectionSummary>
            <PageSectionTitle>Database security and pooling</PageSectionTitle>
          </PageSectionSummary>
        </PageSectionMeta>
        <PageSectionContent>
          <Form {...settingsForm}>
            <form onSubmit={settingsForm.handleSubmit(saveSettings)}>
              <Card>
                <CardContent>
                  <FormField
                    control={settingsForm.control}
                    name="sslEnforced"
                    render={({ field }) => (
                      <FormItemLayout
                        layout="flex-row-reverse"
                        label="Enforce SSL"
                        description="Require TLS at Supavisor and verify the upstream database certificate."
                      >
                        <FormControl>
                          <Switch
                            aria-label="Enforce SSL"
                            checked={field.value}
                            onCheckedChange={field.onChange}
                          />
                        </FormControl>
                      </FormItemLayout>
                    )}
                  />
                </CardContent>
                <CardContent>
                  <FormField
                    control={settingsForm.control}
                    name="caReference"
                    render={({ field }) => (
                      <FormItemLayout
                        layout="flex-row-reverse"
                        label="TLS CA reference"
                        description="File name from the operator-managed TLS CA allowlist."
                      >
                        <FormControl>
                          <Input {...field} placeholder="database-ca.pem" />
                        </FormControl>
                      </FormItemLayout>
                    )}
                  />
                </CardContent>
                <CardContent>
                  <FormField
                    control={settingsForm.control}
                    name="allowedCidrs"
                    render={({ field }) => (
                      <FormItemLayout
                        layout="flex-row-reverse"
                        label="Network restrictions"
                        description="Canonical IPv4 or IPv6 CIDRs, one per line. Leave empty to allow all networks."
                      >
                        <FormControl>
                          <Textarea
                            {...field}
                            rows={4}
                            placeholder={'203.0.113.0/24\n2001:db8::/48'}
                          />
                        </FormControl>
                      </FormItemLayout>
                    )}
                  />
                </CardContent>
                <CardContent>
                  <FormField
                    control={settingsForm.control}
                    name="defaultPoolSize"
                    render={({ field }) => (
                      <FormItemLayout
                        layout="flex-row-reverse"
                        label="Default pool size"
                        description="Maximum upstream connections retained for each pool."
                      >
                        <FormControl>
                          <Input {...field} type="number" min={1} max={1000} />
                        </FormControl>
                      </FormItemLayout>
                    )}
                  />
                </CardContent>
                <CardContent>
                  <FormField
                    control={settingsForm.control}
                    name="maxClientConnections"
                    render={({ field }) => (
                      <FormItemLayout
                        layout="flex-row-reverse"
                        label="Maximum client connections"
                        description="Upper bound for concurrent Supavisor clients."
                      >
                        <FormControl>
                          <Input {...field} type="number" min={10} max={100000} />
                        </FormControl>
                      </FormItemLayout>
                    )}
                  />
                </CardContent>
                <CardFooter className="justify-end gap-2">
                  <Button
                    type="button"
                    disabled={!settingsForm.formState.isDirty || update.isPending}
                    onClick={() => settingsForm.reset()}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    loading={update.isPending}
                    disabled={!canUpdate || !settingsForm.formState.isDirty}
                  >
                    Save
                  </Button>
                </CardFooter>
              </Card>
            </form>
          </Form>
        </PageSectionContent>
      </PageSection>

      <PageSection id="fleet-database-passwords">
        <PageSectionMeta>
          <PageSectionSummary>
            <PageSectionTitle>Database passwords</PageSectionTitle>
          </PageSectionSummary>
        </PageSectionMeta>
        <PageSectionContent>
          <Form {...passwordForm}>
            <form onSubmit={passwordForm.handleSubmit(rotatePassword)}>
              <Card>
                <CardContent>
                  <FormField
                    control={passwordForm.control}
                    name="role"
                    render={({ field }) => (
                      <FormItemLayout
                        layout="flex-row-reverse"
                        label="Connection profile"
                        description="Rotate the primary or read-only connection password."
                      >
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="primary">Primary</SelectItem>
                            <SelectItem value="read-only">Read-only</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormItemLayout>
                    )}
                  />
                </CardContent>
                <CardContent>
                  <FormField
                    control={passwordForm.control}
                    name="newPassword"
                    render={({ field }) => (
                      <FormItemLayout
                        layout="flex-row-reverse"
                        label="New password"
                        description="The password is encrypted before durable storage and is never returned by the API."
                      >
                        <FormControl>
                          <Input {...field} type="password" autoComplete="new-password" />
                        </FormControl>
                      </FormItemLayout>
                    )}
                  />
                </CardContent>
                <CardFooter className="justify-end">
                  <Button
                    type="submit"
                    variant="primary"
                    loading={rotate.isPending}
                    disabled={!canUpdate || !passwordForm.formState.isDirty}
                  >
                    Rotate password
                  </Button>
                </CardFooter>
              </Card>
            </form>
          </Form>
        </PageSectionContent>
      </PageSection>
    </>
  )
}
