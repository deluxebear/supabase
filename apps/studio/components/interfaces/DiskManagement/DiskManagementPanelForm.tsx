import { useParams } from 'common'
import Link from 'next/link'
import { Button } from 'ui'
import { Admonition } from 'ui-patterns/admonition'
import {
  PageSection,
  PageSectionContent,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'

import { DocsButton } from '../../ui/DocsButton'
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
          title={$t('Disk Management has moved')}
          description={$t(
            'Disk configuration is now managed alongside Project Compute on the new Compute and Disk page.'
          )}
          actions={
            <Button variant="default" asChild>
              <Link href={`/project/${projectRef}/settings/compute-and-disk`}>
                {$t('Go to Compute and Disk')}
              </Link>
            </Button>
          }
        />
      </PageSectionContent>
    </PageSection>
  )
}
