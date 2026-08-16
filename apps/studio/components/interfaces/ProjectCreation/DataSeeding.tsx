import { UseFormReturn } from 'react-hook-form'
import { Checkbox, FormControl, FormDescription, FormField, FormItem, FormLabel } from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'

import { CreateProjectForm } from './ProjectCreation.schema'
import Panel from '@/components/ui/Panel'
import { t as $t } from '@/lib/i18n'

interface DataSeedingProps {
  form: UseFormReturn<CreateProjectForm>
  layout?: 'vertical' | 'horizontal'
}

export const DataSeeding = ({ form, layout = 'horizontal' }: DataSeedingProps) => {
  return (
    <Panel.Content className="pb-8">
      <FormItemLayout layout={layout} label={$t('Data seeding')} isReactForm={false}>
        <div className="flex flex-col gap-4">
          <FormField
            name="shouldRunMigrations"
            control={form.control}
            render={({ field }) => (
              <FormItem className="flex items-start gap-3">
                <FormControl>
                  <Checkbox
                    checked={field.value}
                    disabled={field.disabled}
                    onCheckedChange={(value) => field.onChange(value === true)}
                  />
                </FormControl>
                <div className="space-y-1">
                  <FormLabel className="text-sm text-foreground">
                    {$t('Create sample tables with seed data')}
                  </FormLabel>
                  <FormDescription className="text-foreground-lighter">
                    {$t(
                      'To get you started quickly, we can create new tables for you with seed (sample) data. You can delete these tables later.'
                    )}
                  </FormDescription>
                </div>
              </FormItem>
            )}
          />
        </div>
      </FormItemLayout>
    </Panel.Content>
  )
}
