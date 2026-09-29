import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  Form,
  FormControl,
  FormField,
  Input,
} from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import { z } from 'zod'

import { AlertError } from '@/components/ui/AlertError'
import { useManagementTargetCreateMutation } from '@/data/organizations/management-target-create-mutation'
import { useManagementTargetRevokeMutation } from '@/data/organizations/management-target-revoke-mutation'
import { managementTargetsQueryOptions } from '@/data/organizations/management-targets-query'
import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'
import { t as $t, translateDisplayValue as $tValue } from '@/lib/i18n'

const schema = z.object({
  name: z.string().trim().min(1),
  trustDomain: z.string().trim().min(1),
  caReference: z.string().trim().min(1),
  assertionKeyReference: z.string().trim().min(1),
  fleetApiUrl: z
    .string()
    .url()
    .refine((value) => value.startsWith('https://')),
  fleetAudience: z.string().trim().min(1),
  backupApiUrl: z.union([
    z.literal(''),
    z
      .string()
      .url()
      .refine((value) => value.startsWith('https://')),
  ]),
  backupAudience: z.string(),
})

type FormValues = z.infer<typeof schema>

const defaults: FormValues = {
  name: '',
  trustDomain: '',
  caReference: 'file:/run/secrets/fleet-management/ca.crt',
  assertionKeyReference: 'env:FLEET_MANAGEMENT_ASSERTION_PRIMARY',
  fleetApiUrl: 'https://fleet-control:8091',
  fleetAudience: 'fleet-control',
  backupApiUrl: '',
  backupAudience: 'backup-operator',
}

export const ManagementTargetsSettings = () => {
  const { data: organization } = useSelectedOrganizationQuery()
  const targets = useQuery(managementTargetsQueryOptions({ slug: organization?.slug }))
  const [serverError, setServerError] = useState<Error>()
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: defaults })
  const fields = useMemo(
    () => [
      {
        name: 'name' as const,
        label: $t('Name'),
        description: $t('A stable operator location name'),
      },
      {
        name: 'trustDomain' as const,
        label: $t('Trust domain'),
        description: 'SPIFFE trust domain',
      },
      {
        name: 'caReference' as const,
        label: $t('CA reference'),
        description: $t('An allowed env: or file: reference; never paste a private key'),
      },
      {
        name: 'assertionKeyReference' as const,
        label: $t('Assertion key reference'),
        description: $t('An env: reference; the secret is never returned to the browser'),
      },
      {
        name: 'fleetApiUrl' as const,
        label: $t('Fleet Control API URL'),
        description: $t('HTTPS endpoint pinned to the configured CA'),
      },
      {
        name: 'fleetAudience' as const,
        label: $t('Fleet Control audience'),
        description: $t('Service assertion audience'),
      },
      {
        name: 'backupApiUrl' as const,
        label: $t('Backup Operator API URL'),
        description: $t('Optional target-local HTTPS endpoint'),
      },
      {
        name: 'backupAudience' as const,
        label: $t('Backup Operator audience'),
        description: $t('Used only when an Operator URL is provided'),
      },
    ],
    []
  )
  const createTarget = useManagementTargetCreateMutation({
    onSuccess: () => {
      setServerError(undefined)
      form.reset(defaults)
    },
    onError: (error) => setServerError(error),
  })
  const revokeTarget = useManagementTargetRevokeMutation({
    onError: (error) => setServerError(error),
  })

  const onSubmit = (values: FormValues) => {
    if (!organization?.slug) return
    setServerError(undefined)
    createTarget.mutate({
      slug: organization.slug,
      payload: {
        name: values.name,
        trustDomain: values.trustDomain,
        caReference: values.caReference,
        assertionKeyReference: values.assertionKeyReference,
        domains: [
          {
            domain: 'fleet-control',
            apiUrl: values.fleetApiUrl,
            audience: values.fleetAudience,
            contractVersion: 'v1',
            capabilitySchemaPrefix: 'supabase.fleet.',
          },
          ...(values.backupApiUrl
            ? [
                {
                  domain: 'backup-operator' as const,
                  apiUrl: values.backupApiUrl,
                  audience: values.backupAudience,
                  contractVersion: 'v1',
                  capabilitySchemaPrefix: 'supabase.backup.',
                },
              ]
            : []),
        ],
      },
    })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{$t('Management targets')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {targets.isError && (
            <AlertError error={targets.error} subject={$t('Failed to load management targets')} />
          )}
          {serverError && (
            <AlertError error={serverError} subject={$t('Management target operation failed')} />
          )}
          {targets.data?.targets.length === 0 && (
            <p className="text-sm text-foreground-light">
              {$t('No management targets configured.')}
            </p>
          )}
          {targets.data?.targets.map((target) => (
            <div
              key={target.id}
              className="flex items-start justify-between gap-4 rounded-md border p-4"
            >
              <div className="space-y-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{target.name}</span>
                  <Badge>{target.state}</Badge>
                </div>
                <p className="text-sm text-foreground-light">{target.trustDomain}</p>
                {target.domains.map((domain) => (
                  <p key={domain.domain} className="text-xs text-foreground-muted truncate">
                    {domain.domain}: {domain.apiUrl} ({domain.contractVersion})
                  </p>
                ))}
                <p className="text-xs text-foreground-muted">
                  {target.caReference} · {target.assertionKeyReference}
                </p>
              </div>
              <Button
                type="button"
                variant="danger"
                disabled={target.state === 'revoked' || revokeTarget.isPending}
                onClick={() =>
                  organization?.slug &&
                  revokeTarget.mutate({ slug: organization.slug, targetId: target.id })
                }
              >
                {$t('Revoke')}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <Card>
            <CardHeader>
              <CardTitle>{$t('Add management target')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {fields.map((field) => (
                <FormField
                  key={field.name}
                  control={form.control}
                  name={field.name}
                  render={({ field: control, fieldState }) => (
                    <FormItemLayout
                      label={$tValue(field.label)}
                      description={$tValue(field.description)}
                      error={fieldState.error?.message}
                      layout="horizontal"
                    >
                      <FormControl>
                        <Input {...control} />
                      </FormControl>
                    </FormItemLayout>
                  )}
                />
              ))}
            </CardContent>
            <CardFooter className="justify-end border-t py-3">
              <Button type="submit" loading={createTarget.isPending}>
                {$t('Add target')}
              </Button>
            </CardFooter>
          </Card>
        </form>
      </Form>
    </div>
  )
}
