import { PermissionAction } from '@supabase/shared-types/out/constants'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/router'
import { useState } from 'react'
import { toast } from 'sonner'
import { Alert, AlertDescription, CriticalIcon } from 'ui'
import {
  PageSection,
  PageSectionContent,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'

import { ButtonTooltip } from '@/components/ui/ButtonTooltip'
import { TextConfirmModal } from '@/components/ui/TextConfirmModalWrapper'
import {
  findProjectCapability,
  projectCapabilitiesQueryOptions,
} from '@/data/projects/project-capabilities-query'
import { useProjectDeleteMutation } from '@/data/projects/project-delete-mutation'
import { useAsyncCheckPermissions } from '@/hooks/misc/useCheckPermissions'
import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { t as $t } from '@/lib/i18n'

// Fleet removal is a T6 detach: the binding is tombstoned while audit and
// recovery references remain. Infrastructure deletion is never implied.
export const SelfPlatformDeleteProjectPanel = () => {
  const router = useRouter()
  const [isOpen, setIsOpen] = useState(false)
  const { data: project } = useSelectedProjectQuery()
  const { data: organization } = useSelectedOrganizationQuery()
  const { can: canDelete } = useAsyncCheckPermissions(PermissionAction.DELETE, 'projects')
  const capabilities = useQuery(projectCapabilitiesQueryOptions({ projectRef: project?.ref }))

  const { mutate: deleteProject, isPending } = useProjectDeleteMutation({
    onSuccess: () => {
      toast.success($t('Project removed from the platform'))
      router.push(organization?.slug ? `/org/${organization.slug}` : '/organizations')
    },
  })

  if (project === undefined) return null

  const isDefault = project.ref === 'default'
  const detachCapability = findProjectCapability(capabilities.data, 'project.detach')
  const canDetach = detachCapability?.state === 'available'
  const isDisabled = !canDelete || !canDetach || isDefault
  const disabledReason = isDefault
    ? $t('The default project cannot be removed.')
    : !canDelete
      ? $t('Only organization owners can remove projects.')
      : !canDetach
        ? (detachCapability?.blockers[0]?.message ?? $t('Detach is unavailable for this project.'))
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
          <AlertDescription>
            {$t(
              'Detaching revokes the Fleet binding and stops probes and reconciliation. The stack, database, containers, namespaces, PVCs, backup references, and audit history are not deleted.'
            )}
          </AlertDescription>
          <div className="mt-2">
            <ButtonTooltip
              variant="danger"
              disabled={isDisabled}
              onClick={() => setIsOpen(true)}
              tooltip={{ content: { side: 'bottom', text: disabledReason } }}
            >
              {$t('Detach project')}
            </ButtonTooltip>
          </div>
        </Alert>
      </PageSectionContent>

      <TextConfirmModal
        visible={isOpen}
        loading={isPending}
        title={$t('Confirm detach of {{name}}', { name: project.name })}
        variant="destructive"
        confirmPlaceholder={$t('Type the project ref in here')}
        confirmString={project.ref}
        confirmLabel={$t('I understand, detach this project from Fleet Studio')}
        text={$t('No managed infrastructure or backup artifacts will be deleted.')}
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
