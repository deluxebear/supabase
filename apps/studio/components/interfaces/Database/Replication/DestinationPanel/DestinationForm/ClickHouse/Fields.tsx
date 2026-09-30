import { Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import {
  Button,
  FormControl,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from 'ui'
import { Input as PasswordInput } from 'ui-patterns/DataInputs/Input'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'

import { STORED_SECRET_PLACEHOLDER } from '../DestinationForm.constants'
import type { DestinationPanelSchemaType } from '../DestinationForm.schema'
import {
  CLICKHOUSE_DATABASE_FIELD_COPY,
  CLICKHOUSE_ENGINE_FIELD_COPY,
  CLICKHOUSE_URL_FIELD_COPY,
} from '../DestinationFormFieldCopy'
import { t as $t, translateDisplayValue as $tValue } from '@/lib/i18n'

export const ClickHouseFields = ({
  form,
  editMode,
}: {
  form: UseFormReturn<DestinationPanelSchemaType>
  editMode: boolean
}) => {
  const [showPassword, setShowPassword] = useState(false)
  const passwordVisibilityLabel = showPassword ? 'Hide entered password' : 'Show entered password'

  return (
    <div className="flex flex-col gap-y-6 p-5">
      <p className="text-sm font-medium text-foreground">{$t('ClickHouse settings')}</p>

      <div className="flex flex-col gap-y-4">
        <FormField
          control={form.control}
          name="clickhouseUrl"
          render={({ field }) => (
            <FormItemLayout
              layout="horizontal"
              label={$tValue(CLICKHOUSE_URL_FIELD_COPY.label)}
              description={$tValue(CLICKHOUSE_URL_FIELD_COPY.description)}
            >
              <FormControl>
                <Input
                  {...field}
                  value={field.value ?? ''}
                  placeholder="https://your-cluster.clickhouse.cloud:8443"
                />
              </FormControl>
            </FormItemLayout>
          )}
        />

        <FormField
          control={form.control}
          name="clickhouseUser"
          render={({ field }) => (
            <FormItemLayout
              layout="horizontal"
              label={$t('User')}
              description={$t('Dedicated database user with access to the destination database.')}
            >
              <FormControl>
                <Input {...field} value={field.value ?? ''} placeholder="pipelines_user" />
              </FormControl>
            </FormItemLayout>
          )}
        />

        <FormField
          control={form.control}
          name="clickhousePassword"
          render={({ field }) => (
            <FormItemLayout
              layout="horizontal"
              label={$t('Password')}
              labelOptional="Optional"
              description={
                editMode
                  ? $t('Enter a new password to replace the stored one.')
                  : $t('Leave blank if the ClickHouse user has no password.')
              }
            >
              <FormControl>
                <PasswordInput
                  value={field.value ?? ''}
                  type={showPassword && !editMode ? 'text' : 'password'}
                  placeholder={editMode ? STORED_SECRET_PLACEHOLDER : undefined}
                  onChange={(event) => field.onChange(event.target.value)}
                  actions={
                    !editMode && (
                      <div className="flex items-center justify-center">
                        <Button
                          className="w-7"
                          title={passwordVisibilityLabel}
                          aria-label={passwordVisibilityLabel}
                          icon={showPassword ? <Eye /> : <EyeOff />}
                          onClick={() => setShowPassword(!showPassword)}
                        />
                      </div>
                    )
                  }
                />
              </FormControl>
            </FormItemLayout>
          )}
        />

        <FormField
          control={form.control}
          name="clickhouseDatabase"
          render={({ field }) => (
            <FormItemLayout
              layout="horizontal"
              label={$tValue(CLICKHOUSE_DATABASE_FIELD_COPY.label)}
              description={$tValue(CLICKHOUSE_DATABASE_FIELD_COPY.description)}
            >
              <FormControl>
                <Input {...field} value={field.value ?? ''} placeholder="pipelines" />
              </FormControl>
            </FormItemLayout>
          )}
        />

        <FormField
          control={form.control}
          name="clickhouseEngine"
          render={({ field }) => (
            <FormItemLayout
              layout="horizontal"
              label={$tValue(CLICKHOUSE_ENGINE_FIELD_COPY.label)}
              description={$tValue(CLICKHOUSE_ENGINE_FIELD_COPY.description)}
            >
              <FormControl>
                <Select
                  value={field.value ?? 'replacing_merge_tree'}
                  onValueChange={field.onChange}
                >
                  <SelectTrigger>
                    {field.value === 'merge_tree' ? $t('MergeTree') : $t('ReplacingMergeTree')}
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="replacing_merge_tree" className="[&>span]:top-2.5">
                      <p>{$t('ReplacingMergeTree')}</p>
                      <p className="text-foreground-lighter">
                        {$t('Creates current-state views.')}
                      </p>
                    </SelectItem>
                    <SelectItem value="merge_tree" className="[&>span]:top-2.5">
                      <p>{$t('MergeTree')}</p>
                      <p className="text-foreground-lighter">
                        {$t('Keeps an append-only history of changes.')}
                      </p>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </FormControl>
            </FormItemLayout>
          )}
        />
      </div>
    </div>
  )
}
