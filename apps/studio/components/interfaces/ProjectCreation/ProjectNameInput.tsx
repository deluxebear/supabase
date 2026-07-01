import { UseFormReturn } from 'react-hook-form'
import { FormControl, FormField, Input } from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'

import { CreateProjectForm } from './ProjectCreation.schema'
import Panel from '@/components/ui/Panel'
import { t as $t } from '@/lib/i18n'

interface ProjectNameInputProps {
  form: UseFormReturn<CreateProjectForm>
}

export const ProjectNameInput = ({ form }: ProjectNameInputProps) => {
  return (
    <Panel.Content>
      <FormField
        control={form.control}
        name="projectName"
        render={({ field }) => (
          <FormItemLayout label={$t('Project name')} layout="horizontal">
            <FormControl>
              <Input {...field} placeholder={$t('Project name')} />
            </FormControl>
          </FormItemLayout>
        )}
      />
    </Panel.Content>
  )
}
