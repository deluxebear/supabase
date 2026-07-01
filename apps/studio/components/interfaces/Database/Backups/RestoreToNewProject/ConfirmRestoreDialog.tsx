import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
} from 'ui'

import { AdditionalMonthlySpend } from './AdditionalMonthlySpend'
import { NewProjectPrice } from './RestoreToNewProject.utils'
import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { t as $t } from '@/lib/i18n'

interface ConfirmRestoreDialogProps {
  open: boolean
  onOpenChange: (value: boolean) => void
  onSelectContinue: () => void
  additionalMonthlySpend: NewProjectPrice
}

export const ConfirmRestoreDialog = ({
  open,
  onOpenChange,
  onSelectContinue,
  additionalMonthlySpend,
}: ConfirmRestoreDialogProps) => {
  const { data: project } = useSelectedProjectQuery()
  const { data: organization } = useSelectedOrganizationQuery()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader className="border-b">
          <DialogTitle>{$t('Confirm restore to a new project')}</DialogTitle>
          <DialogDescription>
            {$t('This process will create a new project and restore your database to it.')}
          </DialogDescription>
        </DialogHeader>
        <DialogSection className="prose pb-6 space-y-4 text-sm">
          <ul className="space-y-2">
            <li>
              {$t('Project organization will stay the same:')} <code>{organization?.name}</code>
            </li>
            <li>
              {$t('Project region will stay the same:')} <code>{project?.region || ''}</code>
            </li>
          </ul>
          <ul>
            <li>{$t('What will be transferred?')}</li>
            <ul className="ml-4">
              <li>{$t('Database schema (tables, views, procedures)')}</li>
              <li>{$t('All data and indexes')}</li>
              <li>{$t('Database roles, permissions and users')}</li>
            </ul>
          </ul>
          <ul>
            <li>{$t('What needs manual reconfiguration?')}</li>
            <ul className="ml-4">
              <li>{$t('Storage objects & settings')}</li>
              <li>{$t('Edge Functions')}</li>
              <li>{$t('Auth settings & API keys')}</li>
              <li>{$t('Database extensions and settings')}</li>
              <li>{$t('Read replicas')}</li>
            </ul>
          </ul>
        </DialogSection>
        <AdditionalMonthlySpend additionalMonthlySpend={additionalMonthlySpend} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {$t('Cancel')}
          </Button>
          <Button onClick={() => onSelectContinue()}>{$t('Continue')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
