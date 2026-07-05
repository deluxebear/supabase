import { PermissionAction } from '@supabase/shared-types/out/constants'
import { useRouter } from 'next/router'
import { useState } from 'react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle, CriticalIcon } from 'ui'
import {
  PageSection,
  PageSectionContent,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'

import { ButtonTooltip } from '@/components/ui/ButtonTooltip'
import { TextConfirmModal } from '@/components/ui/TextConfirmModalWrapper'
import { useProjectDeleteMutation } from '@/data/projects/project-delete-mutation'
import { useAsyncCheckPermissions } from '@/hooks/misc/useCheckPermissions'
import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { t as $t } from '@/lib/i18n'

// [self-platform] M5.0 T6: DELETE /platform/projects/[ref] (Task 4) only
// removes the registry row — the real database keeps running on its own
// stack. This panel replaces the upstream DeleteProjectPanel (whose copy
// promises permanent data deletion) in self-platform mode; see the
// IS_SELF_PLATFORM swap in pages/project/[ref]/settings/general.tsx.
export const SelfPlatformDeleteProjectPanel = () => {
  const router = useRouter()
  const [isOpen, setIsOpen] = useState(false)
  const { data: project } = useSelectedProjectQuery()
  const { data: organization } = useSelectedOrganizationQuery()
  const { can: canDelete } = useAsyncCheckPermissions(PermissionAction.DELETE, 'projects')

  const { mutate: deleteProject, isPending } = useProjectDeleteMutation({
    onSuccess: () => {
      toast.success($t('Project removed from the platform'))
      router.push(organization?.slug ? `/org/${organization.slug}` : '/organizations')
    },
  })

  if (project === undefined) return null

  const isDefault = project.ref === 'default'
  const isDisabled = !canDelete || isDefault
  const disabledReason = isDefault
    ? $t('The default project cannot be removed.')
    : !canDelete
      ? $t('Only organization owners can remove projects.')
      : undefined

  return (
    <PageSection id="remove-project">
      <PageSectionMeta>
        <PageSectionSummary>
          <PageSectionTitle>{$t('Remove project from platform')}</PageSectionTitle>
        </PageSectionSummary>
      </PageSectionMeta>

      <PageSectionContent>
        <Alert variant="destructive">
          <CriticalIcon />
          <AlertTitle>{$t('Remove project from platform')}</AlertTitle>
          <AlertDescription>
            {$t(
              'Removing a project deletes its registry entry only. The underlying database and stack keep running and can be re-attached later; drop the database manually if you no longer need it.'
            )}
          </AlertDescription>
          <div className="mt-2">
            <ButtonTooltip
              variant="danger"
              disabled={isDisabled}
              onClick={() => setIsOpen(true)}
              tooltip={{ content: { side: 'bottom', text: disabledReason } }}
            >
              {$t('Remove project')}
            </ButtonTooltip>
          </div>
        </Alert>
      </PageSectionContent>

      <TextConfirmModal
        visible={isOpen}
        loading={isPending}
        title={$t('Confirm removal of {{name}}', { name: project.name })}
        variant="destructive"
        confirmPlaceholder={$t('Type the project ref in here')}
        confirmString={project.ref}
        confirmLabel={$t('I understand, remove this project from the platform')}
        text={$t('The database itself is NOT deleted and keeps running on its stack.')}
        onConfirm={() =>
          deleteProject({ projectRef: project.ref, organizationSlug: organization?.slug })
        }
        onCancel={() => {
          if (!isPending) setIsOpen(false)
        }}
      />
    </PageSection>
  )
}
