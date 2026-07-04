import { noop } from 'lodash'
import { Edit, ExternalLink, FlaskConical, Grid } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle, Button, DialogSection } from 'ui'

import CardButton from '@/components/ui/CardButton'
import { t as $t } from '@/lib/i18n'

interface PolicySelectionProps {
  description: string
  showAssistantPreview: boolean
  onViewTemplates: () => void
  onViewEditor: () => void
  onToggleFeaturePreviewModal?: () => void
}

export const PolicySelection = ({
  description = '',
  showAssistantPreview,
  onViewTemplates = noop,
  onViewEditor = noop,
  onToggleFeaturePreviewModal,
}: PolicySelectionProps) => {
  return (
    <DialogSection>
      <div className="flex flex-col gap-y-2">
        <p className="text-sm text-foreground-light">{description}</p>
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-1">
          <CardButton
            title={$t('Get started quickly')}
            description={$t('Create a policy from a template')}
            icon={
              <div className="flex">
                <div
                  className="
                  flex h-8 w-8 items-center
                  justify-center
                  rounded-sm bg-foreground text-background
                "
                >
                  <Grid size={14} strokeWidth={2} />
                </div>
              </div>
            }
            onClick={onViewTemplates}
          />
          <CardButton
            title={$t('For full customization')}
            description={$t('Create a policy from scratch')}
            icon={
              <div className="flex">
                <div
                  className="
                  flex h-8 w-8 items-center
                  justify-center
                  rounded-sm bg-foreground text-background
                "
                >
                  <Edit size={14} strokeWidth={2} />
                </div>
              </div>
            }
            onClick={onViewEditor}
          />
        </div>
      </div>

      {showAssistantPreview && onToggleFeaturePreviewModal !== undefined && (
        <Alert>
          <FlaskConical />
          <AlertTitle>{$t('Try the new Supabase Assistant for RLS policies')}</AlertTitle>
          <AlertDescription>
            {$t('Create RLS policies for your tables with the help of AI')}
          </AlertDescription>
          <div className="flex items-center gap-x-2 mt-3">
            <Button variant="default" onClick={onToggleFeaturePreviewModal}>
              {$t('Toggle feature preview')}
            </Button>
            <Button asChild variant="default" icon={<ExternalLink strokeWidth={1.5} />}>
              <a
                href="https://supabase.com/blog/studio-introducing-assistant#introducing-the-supabase-assistant"
                target="_blank"
                rel="noreferrer"
              >
                {$t('Learn more')}
              </a>
            </Button>
          </div>
        </Alert>
      )}
    </DialogSection>
  )
}
