import { zodResolver } from '@hookform/resolvers/zod'
import { QUEUES_SCHEMA } from '@supabase/pg-meta'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { Button, Form, FormControl, FormField, FormItem, Switch } from 'ui'
import { Admonition } from 'ui-patterns/admonition'
import ConfirmationModal from 'ui-patterns/Dialogs/ConfirmationModal'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import { z } from 'zod'

import { ConstrainedIntegrationTabScaffold } from '@/components/interfaces/Integrations/ConstrainedIntegrationTabScaffold'
import { DocsButton } from '@/components/ui/DocsButton'
import { FormHeader } from '@/components/ui/Forms/FormHeader'
import {
  FormPanelContainer,
  FormPanelContent,
  FormPanelFooter,
} from '@/components/ui/Forms/FormPanel'
import { InlineLink } from '@/components/ui/InlineLink'
import { useProjectPostgrestConfigQuery } from '@/data/config/project-postgrest-config-query'
import { useProjectPostgrestConfigUpdateMutation } from '@/data/config/project-postgrest-config-update-mutation'
import { useQueuesExposePostgrestStatusQuery } from '@/data/database-queues/database-queues-expose-postgrest-status-query'
import { useQueuesQuery } from '@/data/database-queues/database-queues-query'
import { useDatabaseQueueToggleExposeMutation } from '@/data/database-queues/database-queues-toggle-postgrest-mutation'
import { useDatabaseQueuesVersionQuery } from '@/data/database-queues/database-queues-version-query'
import { useTableUpdateMutation } from '@/data/tables/table-update-mutation'
import { useTablesQuery } from '@/data/tables/tables-query'
import { useAsyncCheckPermissions } from '@/hooks/misc/useCheckPermissions'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { DOCS_URL, IS_PLATFORM } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

export const QueuesSettings = () => {
  const { data: project } = useSelectedProjectQuery()
  const { can: canUpdatePostgrestConfig } = useAsyncCheckPermissions(
    PermissionAction.UPDATE,
    'custom_config_postgrest'
  )
  const [isToggling, setIsToggling] = useState(false)
  const [rlsConfirmModalOpen, setRlsConfirmModalOpen] = useState(false)
  const [isUpdatingRls, setIsUpdatingRls] = useState(false)

  const formSchema = z.object({ enable: z.boolean() })
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    mode: 'onChange',
    defaultValues: { enable: false },
  })
  const { formState } = form
  const { enable } = form.watch()

  const { data: queueTables } = useTablesQuery({
    projectRef: project?.ref,
    connectionString: project?.connectionString,
    schema: 'pgmq',
  })
  const tablesWithoutRLS =
    queueTables?.filter((x) => x.name.startsWith('q_') && !x.rls_enabled) ?? []

  // pgmq lowercases queue names when building q_/a_ relations, but pgmq.meta keeps
  // the original casing. Look up each relname in list_queues() so we render the
  // user-provided name rather than the lowercased relname slice.
  const { data: queues } = useQueuesQuery({
    projectRef: project?.ref,
    connectionString: project?.connectionString,
  })
  const queueDisplayName = (relname: string) => {
    const stripped = relname.slice(2)
    return queues?.find((q) => q.queue_name.toLowerCase() === stripped)?.queue_name ?? stripped
  }

  const { data: config, error: configError } = useProjectPostgrestConfigQuery({
    projectRef: project?.ref,
  })

  const {
    data: isExposed,
    isSuccess,
    isPending: isLoading,
  } = useQueuesExposePostgrestStatusQuery({
    projectRef: project?.ref,
    connectionString: project?.connectionString,
  })
  const schemas = config?.db_schema.replace(/ /g, '').split(',') ?? []

  const { data: pgmqVersion } = useDatabaseQueuesVersionQuery({
    projectRef: project?.ref,
    connectionString: project?.connectionString,
  })

  const { mutateAsync: updateTable } = useTableUpdateMutation()

  const onPostgrestConfigUpdateSuccess = () => {
    if (enable) {
      toast.success(
        $t('Queues can now be managed through client libraries or PostgREST endpoints!')
      )
    } else {
      toast.success(
        $t('Queues can no longer be managed through client libraries or PostgREST endpoints')
      )
    }
    setIsToggling(false)
    form.reset({ enable })
  }

  const { mutate: updatePostgrestConfig } = useProjectPostgrestConfigUpdateMutation({
    onSuccess: onPostgrestConfigUpdateSuccess,
    onError: (error) => {
      setIsToggling(false)
      toast.error(`Failed to toggle queue exposure via PostgREST: ${error.message}`)
    },
  })

  const { mutate: toggleExposeQueuePostgrest } = useDatabaseQueueToggleExposeMutation({
    onSuccess: (_, values) => {
      if (!IS_PLATFORM) return onPostgrestConfigUpdateSuccess()
      if (project && config) {
        if (values.enable) {
          const updatedSchemas = schemas.concat([QUEUES_SCHEMA])
          updatePostgrestConfig({
            projectRef: project?.ref,
            dbSchema: updatedSchemas.join(', '),
            maxRows: config.max_rows,
            dbExtraSearchPath: config.db_extra_search_path,
            dbPool: config.db_pool,
          })
        } else {
          const updatedSchemas = schemas.filter((x) => x !== QUEUES_SCHEMA)
          updatePostgrestConfig({
            projectRef: project?.ref,
            dbSchema: updatedSchemas.join(', '),
            maxRows: config.max_rows,
            dbExtraSearchPath: config.db_extra_search_path,
            dbPool: config.db_pool,
          })
        }
      }
    },
    onError: (error) => {
      setIsToggling(false)
      toast.error(`Failed to toggle queue exposure via PostgREST: ${error.message}`)
    },
  })

  const onToggleRLS = async () => {
    if (!project) return console.error('Project is required')
    setIsUpdatingRls(true)
    try {
      await Promise.all(
        tablesWithoutRLS.map((x) =>
          updateTable({
            projectRef: project?.ref,
            connectionString: project?.connectionString,
            id: x.id,
            name: x.name,
            schema: x.schema,
            payload: { id: x.id, rls_enabled: true },
          })
        )
      )
      toast.success(
        `Successfully enabled RLS on ${tablesWithoutRLS.length === 1 ? tablesWithoutRLS[0].name : `${tablesWithoutRLS.length} queue${tablesWithoutRLS.length > 1 ? 's' : ''}`} `
      )
      setRlsConfirmModalOpen(false)
    } catch (error: any) {
      setIsUpdatingRls(false)
      toast.error(`Failed to enable RLS on queues: ${error.message}`)
    }
  }

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    if (!project) return console.error('Project is required')
    if (configError) {
      return toast.error(
        `Failed to toggle queue exposure via PostgREST: Unable to retrieve PostgREST configuration (${configError.message})`
      )
    }
    if (!pgmqVersion) {
      return toast.error($t('Unable to retrieve PGMQ version. Please try again later.'))
    }

    setIsToggling(true)
    toggleExposeQueuePostgrest({
      projectRef: project.ref,
      connectionString: project.connectionString,
      enable: values.enable,
      pgmqVersion,
    })
  }

  useEffect(() => {
    if (isSuccess) form.reset({ enable: isExposed })
  }, [isSuccess])

  return (
    <>
      <ConstrainedIntegrationTabScaffold className="flex flex-col gap-y-4">
        <FormHeader
          className="mb-0"
          title={$t('Settings')}
          description={$t('Manage your queues via any client library or Data APIs endpoints')}
        />
        <Form {...form}>
          <form id="pgmq-postgrest" onSubmit={form.handleSubmit(onSubmit)}>
            <FormPanelContainer>
              <FormPanelContent className="px-8 py-8">
                <FormField
                  control={form.control}
                  name="enable"
                  render={({ field }) => (
                    <FormItem className="w-full">
                      <FormItemLayout
                        className="w-full"
                        layout="flex"
                        label={$t('Expose Queues via PostgREST')}
                        description={
                          <>
                            <p className="max-w-2xl">
                              {$t(
                                'When enabled, you will be able to use the following functions from the'
                              )}{' '}
                              <code className="text-code-inline">{QUEUES_SCHEMA}</code>{' '}
                              {$t(
                                'schema to manage your queues via any Supabase client library or PostgREST endpoints:'
                              )}
                            </p>
                            <p className="mt-2">
                              <code className="text-code-inline">send</code>,{' '}
                              <code className="text-code-inline">send_batch</code>,{' '}
                              <code className="text-code-inline">read</code>,{' '}
                              <code className="text-code-inline">pop</code>,
                              <code className="text-code-inline">archive</code>
                              {$t(', and')} <code className="text-code-inline">delete</code>
                            </p>
                            {!IS_PLATFORM ? (
                              <div className="mt-6 max-w-2xl">
                                {$t(
                                  'When running Supabase locally with the CLI or self-hosting using Docker Compose, you also need to update your configuration to expose the'
                                )}{' '}
                                <code className="text-code-inline">{QUEUES_SCHEMA}</code> schema.
                                <br />
                                <InlineLink
                                  href={`${DOCS_URL}/guides/queues/expose-self-hosted-queues`}
                                >
                                  {$t('Learn more')}
                                </InlineLink>
                              </div>
                            ) : null}
                          </>
                        }
                      >
                        <FormControl>
                          <Switch
                            name="enable"
                            size="large"
                            disabled={
                              isLoading || tablesWithoutRLS.length > 0 || !canUpdatePostgrestConfig
                            }
                            checked={field.value}
                            onCheckedChange={(value) => field.onChange(value)}
                          />
                        </FormControl>
                      </FormItemLayout>
                      {tablesWithoutRLS.length > 0 && (
                        <Admonition
                          type="default"
                          title={$t(
                            'Existing Queues must have RLS enabled first before exposing via PostgREST'
                          )}
                          className="mt-2"
                        >
                          <p className="m-0!">
                            {$t('Please ensure that the following')} {tablesWithoutRLS.length} queue
                            {tablesWithoutRLS.length > 1 ? 's' : ''}{' '}
                            {$t('have RLS enabled in order to prevent anonymous access.')}
                          </p>
                          <ul className="list-disc pl-6">
                            {tablesWithoutRLS.map((x) => {
                              return (
                                <li key={x.name}>
                                  <code className="text-code-inline">
                                    {queueDisplayName(x.name)}
                                  </code>
                                </li>
                              )
                            })}
                          </ul>

                          <Button
                            variant="default"
                            className="mt-3"
                            onClick={() => setRlsConfirmModalOpen(true)}
                          >
                            {$t('Enable RLS on')}{' '}
                            {tablesWithoutRLS.length === 1
                              ? queueDisplayName(tablesWithoutRLS[0].name)
                              : `${tablesWithoutRLS.length} queues`}
                          </Button>
                        </Admonition>
                      )}
                      {formState.dirtyFields.enable && field.value === true && (
                        <Admonition type="warning" className="mt-2">
                          <p>
                            {$t('Queues will be exposed and managed through the')}{' '}
                            <code className="text-code-inline">{QUEUES_SCHEMA}</code> schema
                          </p>
                          <p className="text-foreground-light">
                            {$t('Database functions will be created in the')}{' '}
                            <code className="text-code-inline">{QUEUES_SCHEMA}</code>{' '}
                            {$t(
                              'schema upon enabling. Call these functions via any Supabase client library or PostgREST endpoint to manage your queues. Permissions on individual queues can also be further managed through privileges and row level security (RLS).'
                            )}
                          </p>
                        </Admonition>
                      )}
                      {formState.dirtyFields.enable && field.value === false && (
                        <Admonition type="warning" className="mt-2">
                          <p>
                            {$t('The')} <code className="text-code-inline">{QUEUES_SCHEMA}</code>{' '}
                            {$t('schema will be removed once disabled')}
                          </p>
                          <p className="text-foreground-light">
                            {$t('Ensure that the database functions from the')}{' '}
                            <code className="text-code-inline">{QUEUES_SCHEMA}</code>{' '}
                            {$t(
                              'schema are not in use within your client applications before disabling.'
                            )}
                          </p>
                        </Admonition>
                      )}
                    </FormItem>
                  )}
                />
              </FormPanelContent>

              <FormPanelFooter className="flex px-8 py-4 flex items-center justify-between">
                <DocsButton
                  href={`${DOCS_URL}/guides/queues/quickstart#expose-queues-to-client-side-consumers`}
                />
                <div className="flex items-center gap-x-2">
                  <Button
                    variant="default"
                    disabled={Object.keys(formState.dirtyFields).length === 0 || isToggling}
                    onClick={() => form.reset({ enable: false })}
                  >
                    {$t('Cancel')}
                  </Button>
                  <Button
                    variant="primary"
                    type="submit"
                    disabled={Object.keys(formState.dirtyFields).length === 0}
                    loading={isToggling}
                  >
                    {$t('Save changes')}
                  </Button>
                </div>
              </FormPanelFooter>
            </FormPanelContainer>
          </form>
        </Form>
      </ConstrainedIntegrationTabScaffold>

      <ConfirmationModal
        visible={rlsConfirmModalOpen}
        title={$t('Enable Row Level Security')}
        confirmLabel="Enable RLS"
        confirmLabelLoading="Enabling RLS"
        loading={isUpdatingRls}
        onCancel={() => setRlsConfirmModalOpen(false)}
        onConfirm={() => onToggleRLS()}
      >
        <p className="text-sm text-foreground-light">
          {$t('Are you sure you want to enable Row Level Security for the following queues:')}
        </p>
        <ul className="list-disc pl-6">
          {tablesWithoutRLS.map((x) => {
            return (
              <li key={x.id}>
                <code className="text-code-inline">{queueDisplayName(x.name)}</code>
              </li>
            )
          })}
        </ul>
      </ConfirmationModal>
    </>
  )
}
