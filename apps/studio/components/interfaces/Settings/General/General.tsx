import { zodResolver } from '@hookform/resolvers/zod'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import { IS_PLATFORM } from 'common'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { Button, Card, CardContent, CardFooter, Form, FormControl, FormField, Input } from 'ui'
import { Admonition } from 'ui-patterns/admonition'
import { Input as PasswordInput } from 'ui-patterns/DataInputs/Input'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import {
  PageSection,
  PageSectionContent,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'
import * as z from 'zod'

import { AVAILABLE_REPLICA_REGIONS } from '../Infrastructure/InfrastructureConfiguration/InstanceConfiguration.constants'
import { ProjectAccessSection } from './ProjectAccessSection'
import { DocsButton } from '@/components/ui/DocsButton'
import { InlineLink } from '@/components/ui/InlineLink'
import { useProjectUpdateMutation } from '@/data/projects/project-update-mutation'
import { useAsyncCheckPermissions } from '@/hooks/misc/useCheckPermissions'
import { useDeploymentMode } from '@/hooks/misc/useDeploymentMode'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

export const General = () => {
  const { data: project } = useSelectedProjectQuery()
  const isBranch = Boolean(project?.parent_project_ref)

  const { can: canUpdateProject } = useAsyncCheckPermissions(PermissionAction.UPDATE, 'projects', {
    resource: {
      project_id: project?.id,
    },
  })

  const { mutate: updateProject, isPending: isUpdating } = useProjectUpdateMutation()

  const formSchema = z.object({
    name: z.string().trim().min(3, 'Project name must be at least 3 characters long'),
  })

  const defaultValues = { name: project?.name ?? '' }
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues,
    values: defaultValues,
    mode: 'onSubmit',
    reValidateMode: 'onBlur',
  })

  const regionLabel = AVAILABLE_REPLICA_REGIONS.find((region) =>
    project?.region?.includes(region.region)
  )

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    if (!project?.ref) return console.error('Ref is required')

    updateProject(
      { ref: project.ref, name: values.name.trim() },
      {
        onSuccess: ({ name }) => {
          form.reset({ name })
          toast.success($t('Successfully saved settings'))
        },
      }
    )
  }

  const { isCli, isSelfHosted } = useDeploymentMode()

  if (!IS_PLATFORM) {
    return (
      <PageSection>
        <PageSectionMeta>
          <PageSectionSummary>
            <PageSectionTitle>{$t('General settings')}</PageSectionTitle>
          </PageSectionSummary>
        </PageSectionMeta>
        <PageSectionContent className="space-y-4">
          {project === undefined ? (
            <Card>
              <CardContent>
                <GenericSkeletonLoader />
              </CardContent>
            </Card>
          ) : (
            <Form {...form}>
              <Card>
                <CardContent>
                  <FormItemLayout
                    layout="flex-row-reverse"
                    label={$t('Project name')}
                    className="[&>div]:md:w-1/2 [&>div>div]:md:w-full"
                  >
                    <Input readOnly value={project.name ?? ''} />
                  </FormItemLayout>
                </CardContent>
              </Card>
            </Form>
          )}
          {isCli && (
            <Admonition
              type="default"
              title={$t('Local development with the Supabase CLI')}
              description={
                <p>
                  {$t('Project settings are configured in')}{' '}
                  <code className="text-code-inline">supabase/config.toml</code>{' '}
                  {$t('— applied on')}{' '}
                  <code className="text-code-inline">{$t('supabase start')}</code>.
                </p>
              }
              actions={<DocsButton href={`${DOCS_URL}/guides/local-development`} />}
            />
          )}
          {isSelfHosted && (
            <Admonition
              type="default"
              title={$t('Self-hosted Supabase')}
              description={
                <p>{$t('Project settings are configured via environment variables.')}</p>
              }
              actions={<DocsButton href={`${DOCS_URL}/guides/self-hosting`} />}
            />
          )}
        </PageSectionContent>
      </PageSection>
    )
  }

  return (
    <>
      <PageSection>
        <PageSectionMeta>
          <PageSectionSummary>
            <PageSectionTitle>{$t('General settings')}</PageSectionTitle>
          </PageSectionSummary>
        </PageSectionMeta>
        <PageSectionContent>
          {isBranch && (
            <Admonition
              type="default"
              className="mb-4"
              title={$t('You are currently on a preview branch of your project')}
            >
              {$t(
                "Certain settings are not available while you're on a preview branch. To adjust your project settings, you may return to your"
              )}{' '}
              <InlineLink href={`/project/${project?.parent_project_ref}/settings/general`}>
                {$t('main branch')}
              </InlineLink>
              .
            </Admonition>
          )}

          {project === undefined ? (
            <Card>
              <CardContent>
                <GenericSkeletonLoader />
              </CardContent>
            </Card>
          ) : (
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)}>
                <Card>
                  <CardContent>
                    <FormField
                      control={form.control}
                      name="name"
                      render={({ field }) => (
                        <FormItemLayout
                          layout="flex-row-reverse"
                          label={$t('Project name')}
                          description={$t('Displayed throughout the dashboard.')}
                          className="[&>div]:md:w-1/2"
                        >
                          <FormControl>
                            <Input
                              {...field}
                              disabled={isBranch || !canUpdateProject}
                              autoComplete="off"
                            />
                          </FormControl>
                        </FormItemLayout>
                      )}
                    />
                  </CardContent>

                  <CardContent>
                    <FormItemLayout
                      layout="flex-row-reverse"
                      label={$t('Project ID')}
                      description={$t('Reference used in APIs and URLs.')}
                      className="[&>div]:md:w-1/2 [&>div>div]:md:w-full"
                    >
                      <FormControl>
                        <PasswordInput copy readOnly size="small" value={project.ref} />
                      </FormControl>
                    </FormItemLayout>
                  </CardContent>

                  <CardContent>
                    <FormItemLayout
                      layout="flex-row-reverse"
                      label={$t('Project region')}
                      description={regionLabel?.name}
                      className="[&>div]:md:w-1/2 [&>div>div]:md:w-full"
                    >
                      <FormControl>
                        <PasswordInput copy readOnly size="small" value={project.region} />
                      </FormControl>
                    </FormItemLayout>
                  </CardContent>

                  <CardFooter className="justify-end space-x-2">
                    {form.formState.isDirty && (
                      <Button
                        variant="default"
                        type="button"
                        disabled={isUpdating}
                        onClick={() => form.reset({ name: project?.name ?? '' })}
                      >
                        {$t('Cancel')}
                      </Button>
                    )}
                    <Button
                      variant="primary"
                      type="submit"
                      disabled={
                        !form.formState.isDirty || isUpdating || !canUpdateProject || isBranch
                      }
                      loading={isUpdating}
                    >
                      {$t('Save changes')}
                    </Button>
                  </CardFooter>
                </Card>
              </form>
            </Form>
          )}
        </PageSectionContent>
      </PageSection>

      <ProjectAccessSection />
    </>
  )
}
