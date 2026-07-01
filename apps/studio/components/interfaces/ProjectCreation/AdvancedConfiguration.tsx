import { useFlag } from 'common'
import { UseFormReturn } from 'react-hook-form'
import {
  Badge,
  Card,
  CardContent,
  cn,
  FormControl,
  FormField,
  FormItem,
  RadioGroupStacked,
  RadioGroupStackedItem,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from 'ui'
import { Admonition } from 'ui-patterns/admonition'
import { CollapsibleCardSection } from 'ui-patterns/CollapsibleCardSection'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'

import { CreateProjectForm } from './ProjectCreation.schema'
import { DocsButton } from '@/components/ui/DocsButton'
import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

interface AdvancedConfigurationProps {
  form: UseFormReturn<CreateProjectForm>
}

export const AdvancedConfiguration = ({ form }: AdvancedConfigurationProps) => {
  const disableOrioleProjectCreation = useFlag('disableOrioleProjectCreation')

  return (
    <Card className="border-0 border-b rounded-none">
      <CardContent>
        <CollapsibleCardSection
          title={$t('Advanced Configuration')}
          description={$t('These settings cannot be changed after the project is created')}
        >
          <FormField
            name="useOrioleDb"
            control={form.control}
            render={({ field }) => (
              <>
                <FormItemLayout
                  layout="horizontal"
                  label={$t('Postgres Type')}
                  className="[&>div>label]:break-normal!"
                >
                  <FormControl>
                    <RadioGroupStacked
                      // Due to radio group not supporting boolean values
                      // value is converted to boolean
                      onValueChange={(value) => field.onChange(value === 'true')}
                      defaultValue={field.value.toString()}
                    >
                      <FormItem asChild>
                        <FormControl>
                          <RadioGroupStackedItem
                            value="false"
                            // @ts-ignore
                            label={
                              <>
                                {$t('Postgres')}
                                <Badge>{$t('Default')}</Badge>
                              </>
                            }
                            description={$t('Recommended for production workloads')}
                            className="[&>div>div>p]:text-left [&>div>div>p]:text-xs [&>div>div>label]:flex [&>div>div>label]:items-center [&>div>div>label]:gap-x-2"
                          />
                        </FormControl>
                      </FormItem>
                      <FormItem asChild>
                        <FormControl>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <RadioGroupStackedItem
                                value="true"
                                // @ts-ignore
                                label={
                                  <>
                                    {$t('Postgres with OrioleDB')}
                                    <Badge variant="warning">{$t('Alpha')}</Badge>
                                  </>
                                }
                                description={$t('Not recommended for production workloads')}
                                className={cn(
                                  '[&>div>div>p]:text-left [&>div>div>p]:text-xs [&>div>div>label]:flex [&>div>div>label]:items-center [&>div>div>label]:gap-x-2',
                                  form.getValues('useOrioleDb') ? 'rounded-b-none!' : ''
                                )}
                                disabled={disableOrioleProjectCreation}
                              />
                            </TooltipTrigger>
                            {disableOrioleProjectCreation && (
                              <TooltipContent side="right" className="w-60 text-center">
                                {$t(
                                  'OrioleDB is temporarily disabled for new projects. Please try again later.'
                                )}
                              </TooltipContent>
                            )}
                          </Tooltip>
                        </FormControl>
                      </FormItem>
                    </RadioGroupStacked>
                  </FormControl>
                  {form.getValues('useOrioleDb') && (
                    <Admonition
                      type="warning"
                      className="rounded-t-none [&>div]:text-xs"
                      title={$t('OrioleDB is not production ready')}
                      description={$t(
                        'Postgres with OrioleDB extension is currently in Public Alpha and not recommended for production usage yet.'
                      )}
                    >
                      <DocsButton className="mt-2" href={`${DOCS_URL}/guides/database/orioledb`} />
                    </Admonition>
                  )}
                </FormItemLayout>
              </>
            )}
          />
        </CollapsibleCardSection>
      </CardContent>
    </Card>
  )
}
