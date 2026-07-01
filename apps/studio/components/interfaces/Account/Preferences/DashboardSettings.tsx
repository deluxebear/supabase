import {
  PageSection,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'

import { DashboardSettingsToggles } from './DashboardSettingsToggles'
import { t as $t } from '@/lib/i18n'

export const DashboardSettings = () => {
  return (
    <PageSection>
      <PageSectionMeta>
        <PageSectionSummary>
          <PageSectionTitle id="dashboard">{$t('Dashboard')}</PageSectionTitle>
          <PageSectionDescription>
            {$t('Customize how the dashboard works on this browser and device.')}
          </PageSectionDescription>
        </PageSectionSummary>
      </PageSectionMeta>
      <PageSectionContent>
        <DashboardSettingsToggles />
      </PageSectionContent>
    </PageSection>
  )
}
