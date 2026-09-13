import { useParams } from 'common'
import Link from 'next/link'
import { Button } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import {
  PageSection,
  PageSectionContent,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'

import { DocsButton } from '../../ui/DocsButton'
import { getInfrastructurePath } from '@/components/interfaces/Settings/Infrastructure/Infrastructure.utils'
import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

// [Joshen] Only used for non AWS projects
export function DiskManagementPanelForm() {
  const { ref: projectRef } = useParams()

  return (
    <PageSection id="disk-management">
      <PageSectionMeta>
        <PageSectionSummary>
          <PageSectionTitle>{$t('Disk management')}</PageSectionTitle>
        </PageSectionSummary>
        <DocsButton href={`${DOCS_URL}/guides/platform/database-size#disk-management`} />
      </PageSectionMeta>
      <PageSectionContent>
        <Admonition
          type="default"
          layout="responsive"
          title={$t('Disk management has moved')}
          description={$t(
            'Disk configuration is now managed alongside project compute on the Infrastructure page.'
          )}
          actions={
            <Button asChild>
              <Link href={getInfrastructurePath(projectRef)}>{$t('Go to Infrastructure')}</Link>
            </Button>
          }
        />
      </PageSectionContent>
    </PageSection>
  )
}
