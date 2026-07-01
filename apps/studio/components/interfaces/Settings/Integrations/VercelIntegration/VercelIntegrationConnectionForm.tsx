import { zodResolver } from '@hookform/resolvers/zod'
import Link from 'next/link'
import { useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { toast } from 'sonner'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
  Switch,
} from 'ui'
import { Admonition } from 'ui-patterns/admonition'
import ConfirmationModal from 'ui-patterns/Dialogs/ConfirmationModal'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import * as z from 'zod'

import { FormActions } from '@/components/ui/Forms/FormActions'
import { InlineLink } from '@/components/ui/InlineLink'
import type {
  EnvironmentTargets,
  Integration,
  IntegrationProjectConnection,
} from '@/data/integrations/integrations.types'
import { useVercelConnectionUpdateMutation } from '@/data/integrations/vercel-connection-update-mutate'
import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

const VercelIntegrationConnectionForm = ({
  disabled,
  connection,
  integration,
}: {
  disabled?: boolean
  connection: IntegrationProjectConnection
  integration: Integration
}) => {
  // NOTE(kamil): Ignore sync targets for Vercel Marketplace as it's not synchronized using integration,
  // but through a separate marketplace mechanism. It's not theoretically necessary, but we might have some stale data.
  const { data: org } = useSelectedOrganizationQuery()
  const { data: project } = useSelectedProjectQuery()
  const isBranchingEnabled = project?.is_branch_enabled === true
  const envSyncTargets =
    org?.managed_by === 'vercel-marketplace' ? [] : (connection.env_sync_targets ?? [])

  const FormSchema = z.object({
    environmentVariablesProduction: z.boolean().default(envSyncTargets.includes('production')),
    environmentVariablesPreview: z.boolean().default(envSyncTargets.includes('preview')),
    environmentVariablesDevelopment: z.boolean().default(envSyncTargets.includes('development')),
    publicEnvVarPrefix: z.string().optional(),
  })

  const form = useForm<z.infer<typeof FormSchema>>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      environmentVariablesProduction: envSyncTargets.includes('production'),
      environmentVariablesPreview: envSyncTargets.includes('preview'),
      environmentVariablesDevelopment: envSyncTargets.includes('development'),
      publicEnvVarPrefix: connection.public_env_var_prefix,
    },
  })

  const [showConfirmation, setShowConfirmation] = useState(false)
  const [pendingValues, setPendingValues] = useState<z.infer<typeof FormSchema> | null>(null)

  const { mutate: updateVercelConnection, isPending } = useVercelConnectionUpdateMutation({
    onSuccess: () => {
      form.reset(form.getValues())
      setShowConfirmation(false)
      setPendingValues(null)
      toast.success(`Updated Vercel connection`)
    },
  })

  // Syncing the `preview` or `development` target sends this project's production credentials
  // (anon and service role keys, database connection strings) to those Vercel environments. Watch
  // the toggles so we can warn inline and gate the save behind a confirmation.
  const [syncPreview, syncDevelopment] = useWatch({
    control: form.control,
    name: ['environmentVariablesPreview', 'environmentVariablesDevelopment'],
  })
  const isSyncingNonProdEnvs = syncPreview || syncDevelopment

  const selectedNonProdTargets: string[] = []
  if (pendingValues?.environmentVariablesPreview) selectedNonProdTargets.push('Preview')
  if (pendingValues?.environmentVariablesDevelopment) selectedNonProdTargets.push('Development')

  function performUpdate(data: z.infer<typeof FormSchema>) {
    const targets: EnvironmentTargets[] = []

    if (data.environmentVariablesProduction) targets.push('production')
    if (data.environmentVariablesPreview) targets.push('preview')
    if (data.environmentVariablesDevelopment) targets.push('development')

    updateVercelConnection({
      id: connection.id,
      envSyncTargets: targets,
      publicEnvVarPrefix: data.publicEnvVarPrefix?.trim(),
      organizationIntegrationId: integration.id,
    })
  }

  function onSubmit(data: z.infer<typeof FormSchema>) {
    // Always confirm when Preview/Development sync is enabled to discourage leaking production
    // credentials into preview deployments and steer users toward Branching instead.
    if (data.environmentVariablesPreview || data.environmentVariablesDevelopment) {
      setPendingValues(data)
      setShowConfirmation(true)
      return
    }

    performUpdate(data)
  }

  const vercelConnectionFormId = `vercel-connection-form-${connection.id}`

  return (
    <Form {...form}>
      <form
        id={vercelConnectionFormId}
        onSubmit={form.handleSubmit(onSubmit)}
        className={'w-full space-y-6'}
      >
        <div className="px-6 py-4 flex flex-col gap-y-4">
          <div className="flex flex-col gap-4">
            {org?.managed_by === 'vercel-marketplace' ? (
              <Alert>
                <AlertTitle className="text-sm">
                  {$t('Vercel Marketplace managed project')}
                </AlertTitle>
                <AlertDescription className="text-xs">
                  {$t(
                    'This project is managed via Vercel Marketplace. Environment variables are automatically synchronized for your connected Vercel projects. This integration purpose is synchronizing preview deployments environment variables with our'
                  )}{' '}
                  <Link
                    target="_blank"
                    rel="noreferrer"
                    href={`${DOCS_URL}/guides/platform/branching`}
                    className="underline"
                  >
                    {$t('Branching')}
                  </Link>{' '}
                  feature.
                </AlertDescription>
              </Alert>
            ) : (
              <div>
                <div className="space-y-1 mb-4">
                  <h5 className="text-foreground">{$t('Sync environment variables to Vercel')}</h5>
                  <p className="text-sm text-foreground-light">
                    {$t('Choose which Vercel environments receive this project&apos;s')}{' '}
                    <span className="text-foreground">production</span>{' '}
                    {$t('credentials. Most projects only need')} <code>production</code>.
                  </p>
                  <p className="text-sm text-foreground-light">
                    {$t('With')}{' '}
                    <InlineLink href={`/project/${project?.ref}/branches`}>
                      {$t('Branching')}
                    </InlineLink>{' '}
                    {$t(
                      'enabled, leave Preview and Development off: Branching gives each preview branch its own database and syncs those credentials to your Vercel Preview deployments.'
                    )}
                  </p>
                </div>

                <div className="space-y-4">
                  <FormField
                    control={form.control}
                    name="environmentVariablesProduction"
                    render={({ field }) => (
                      <FormItemLayout
                        layout="flex-row-reverse"
                        label={$t('Production')}
                        description={
                          <>
                            {$t('Syncs to the Vercel')} <code>production</code> env.
                          </>
                        }
                      >
                        <FormControl>
                          <Switch
                            disabled={disabled}
                            checked={field.value}
                            onCheckedChange={field.onChange}
                          />
                        </FormControl>
                      </FormItemLayout>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="environmentVariablesPreview"
                    render={({ field }) => (
                      <FormItemLayout
                        layout="flex-row-reverse"
                        label={$t('Preview')}
                        description={
                          <>
                            {$t('Syncs to the Vercel')} <code>preview</code> env.
                          </>
                        }
                      >
                        <FormControl>
                          <Switch
                            disabled={disabled}
                            checked={field.value}
                            onCheckedChange={field.onChange}
                          />
                        </FormControl>
                      </FormItemLayout>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="environmentVariablesDevelopment"
                    render={({ field }) => (
                      <FormItemLayout
                        layout="flex-row-reverse"
                        label={$t('Development')}
                        description={
                          <>
                            {$t('Syncs to the Vercel')} <code>development</code> env.
                          </>
                        }
                      >
                        <FormControl>
                          <Switch
                            disabled={disabled}
                            checked={field.value}
                            onCheckedChange={field.onChange}
                          />
                        </FormControl>
                      </FormItemLayout>
                    )}
                  />

                  {isSyncingNonProdEnvs && (
                    <Admonition
                      type="warning"
                      title={
                        isBranchingEnabled
                          ? 'Not recommended with Branching'
                          : 'These environments will use production credentials'
                      }
                    >
                      <p>
                        {$t(
                          'Preview and Development sync your production credentials, including the service role key and database password, to those Vercel environments.'
                        )}
                      </p>
                      {isBranchingEnabled ? (
                        <p>
                          <InlineLink href={`/project/${project?.ref}/branches`}>
                            {$t('Branching')}
                          </InlineLink>{' '}
                          {$t(
                            'already provisions isolated credentials for each preview branch. With Preview enabled, deployments use production credentials until a branch finishes provisioning, which can affect production data. We recommend leaving Preview and Development off.'
                          )}
                        </p>
                      ) : (
                        <p>
                          {$t('To give preview deployments their own isolated credentials, use')}{' '}
                          <InlineLink href={`/project/${project?.ref}/branches`}>
                            {$t('Branching')}
                          </InlineLink>{' '}
                          instead.
                        </p>
                      )}
                    </Admonition>
                  )}
                </div>
              </div>
            )}
          </div>
          <h5 className="mt-2 text-foreground">
            {$t('Customize public environment variable prefix')}
          </h5>
          <div className="flex flex-col gap-4">
            <FormField
              control={form.control}
              name="publicEnvVarPrefix"
              render={({ field }) => (
                <FormItem className="grid gap-2 md:grid md:grid-cols-12 space-y-0">
                  <FormLabel className="flex flex-col space-y-2 col-span-4 text-sm justify-center text-foreground-light">
                    {$t('Prefix')}
                  </FormLabel>
                  <FormControl className="col-span-8">
                    <Input
                      {...field}
                      className="w-full"
                      disabled={disabled}
                      placeholder={$t('An empty prefix will result in no public env vars')}
                    />
                  </FormControl>
                  <FormDescription className="col-start-5 col-span-8 text-xs">
                    e.g.{' '}
                    <code
                      className="cursor-pointer"
                      role="button"
                      onClick={() => {
                        field.onChange('NEXT_PUBLIC_')
                      }}
                    >
                      NEXT_PUBLIC_
                    </code>
                    ,{' '}
                    <code
                      className="cursor-pointer"
                      role="button"
                      onClick={() => {
                        field.onChange('VITE_PUBLIC_')
                      }}
                    >
                      VITE_PUBLIC_
                    </code>
                    ,{' '}
                    <code
                      className="cursor-pointer"
                      role="button"
                      onClick={() => {
                        field.onChange('PUBLIC_')
                      }}
                    >
                      PUBLIC_
                    </code>
                    {$t(', etc.')}
                  </FormDescription>

                  <FormMessage className="col-start-5 col-span-8" />
                </FormItem>
              )}
            />
          </div>

          {form.formState.isDirty ? (
            <p className="mt-2 text-sm text-warning">
              {$t('Note: Changing these settings will')} <strong>not</strong>{' '}
              {$t('trigger a resync of environment variables.')}
            </p>
          ) : (
            <div className="mt-2 h-5 w-full" />
          )}

          <FormActions
            disabled={disabled}
            form={vercelConnectionFormId}
            hasChanges={form.formState.isDirty}
            isSubmitting={isPending}
            handleReset={() => form.reset()}
          />
        </div>
      </form>

      <ConfirmationModal
        visible={showConfirmation}
        variant="warning"
        size="medium"
        loading={isPending}
        title={$t('Sync production credentials?')}
        confirmLabel="Sync credentials"
        confirmLabelLoading="Saving"
        onCancel={() => {
          setShowConfirmation(false)
          setPendingValues(null)
        }}
        onConfirm={() => {
          if (pendingValues) performUpdate(pendingValues)
        }}
        alert={{
          title: 'These environments will use production credentials',
          description:
            'Including the project ref, API URL, anon and service role keys, and database connection strings.',
        }}
      >
        <div className="space-y-3 text-sm text-foreground-light">
          <p>
            {$t('This syncs your production credentials to the')}{' '}
            <span className="text-foreground">{selectedNonProdTargets.join(' and ')}</span>{' '}
            environment{selectedNonProdTargets.length > 1 ? 's' : ''}{' '}
            {$t('of your connected Vercel project.')}
          </p>
          {isBranchingEnabled ? (
            <p>
              {$t(
                'Branching already provisions isolated credentials for each preview branch. With this enabled, deployments use production credentials until a branch finishes provisioning, which can affect production data. We recommend leaving it off.'
              )}
            </p>
          ) : (
            <p>
              {$t('To use isolated credentials for preview deployments instead, enable')}{' '}
              <InlineLink href={`/project/${project?.ref}/branches`}>{$t('Branching')}</InlineLink>.
            </p>
          )}
        </div>
      </ConfirmationModal>
    </Form>
  )
}

export default VercelIntegrationConnectionForm
