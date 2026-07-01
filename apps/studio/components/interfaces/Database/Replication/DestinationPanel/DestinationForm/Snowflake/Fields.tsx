import { Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import { Button, FormControl, FormField, Input, TextArea } from 'ui'
import { Input as PasswordInput } from 'ui-patterns/DataInputs/Input'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'

import type { DestinationPanelSchemaType } from '../DestinationForm.schema'
import { t as $t } from '@/lib/i18n'

export const SnowflakeFields = ({ form }: { form: UseFormReturn<DestinationPanelSchemaType> }) => {
  const [showPrivateKeyPassphrase, setShowPrivateKeyPassphrase] = useState(false)

  return (
    <div className="flex flex-col gap-y-6 p-5">
      <p className="text-sm font-medium text-foreground">{$t('Snowflake settings')}</p>

      <div className="flex flex-col gap-y-1">
        <p className="text-sm font-medium text-foreground">{$t('Connection')}</p>
        <p className="text-sm text-foreground-light">
          {$t('Configure the Snowflake account, user, and target namespace for replicated data.')}
        </p>
      </div>

      <div className="flex flex-col gap-y-4">
        <FormField
          control={form.control}
          name="snowflakeAccountId"
          render={({ field }) => (
            <FormItemLayout
              layout="horizontal"
              label={$t('Account ID')}
              description={$t('Snowflake account identifier, for example ORGNAME-ACCOUNTNAME')}
            >
              <FormControl>
                <Input {...field} placeholder={$t('MYORG-MYACCOUNT')} value={field.value ?? ''} />
              </FormControl>
            </FormItemLayout>
          )}
        />

        <FormField
          control={form.control}
          name="snowflakeUser"
          render={({ field }) => (
            <FormItemLayout
              layout="horizontal"
              label={$t('User')}
              description={$t('Snowflake user configured for key-pair authentication')}
            >
              <FormControl>
                <Input {...field} placeholder="ETL_USER" value={field.value ?? ''} />
              </FormControl>
            </FormItemLayout>
          )}
        />

        <FormField
          control={form.control}
          name="snowflakeDatabase"
          render={({ field }) => (
            <FormItemLayout
              layout="horizontal"
              label={$t('Database')}
              description={$t('Snowflake database where replicated tables will be created')}
            >
              <FormControl>
                <Input {...field} placeholder="ANALYTICS" value={field.value ?? ''} />
              </FormControl>
            </FormItemLayout>
          )}
        />

        <FormField
          control={form.control}
          name="snowflakeSchema"
          render={({ field }) => (
            <FormItemLayout
              layout="horizontal"
              label={$t('Schema')}
              description={$t('Snowflake schema where replicated tables will be created')}
            >
              <FormControl>
                <Input {...field} placeholder="PUBLIC" value={field.value ?? ''} />
              </FormControl>
            </FormItemLayout>
          )}
        />

        <FormField
          control={form.control}
          name="snowflakeRole"
          render={({ field }) => (
            <FormItemLayout
              layout="horizontal"
              label={$t('Role')}
              description={$t('Optional Snowflake role to assume after connecting')}
            >
              <FormControl>
                <Input {...field} placeholder="ETL_ROLE" value={field.value ?? ''} />
              </FormControl>
            </FormItemLayout>
          )}
        />
      </div>

      <div className="flex flex-col gap-y-1">
        <p className="text-sm font-medium text-foreground">{$t('Authentication')}</p>
        <p className="text-sm text-foreground-light">
          {$t('Use the RSA private key whose public key is registered on the Snowflake user.')}
        </p>
      </div>

      <div className="flex flex-col gap-y-4">
        <FormField
          control={form.control}
          name="snowflakePrivateKey"
          render={({ field }) => (
            <FormItemLayout
              layout="horizontal"
              label={$t('Private key')}
              description={$t('RSA private key PEM contents in PKCS#8 or PKCS#1 format')}
            >
              <FormControl>
                <TextArea
                  {...field}
                  rows={8}
                  maxLength={10000}
                  placeholder={'-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----'}
                  value={field.value ?? ''}
                  className="font-mono text-xs"
                />
              </FormControl>
            </FormItemLayout>
          )}
        />

        <FormField
          control={form.control}
          name="snowflakePrivateKeyPassphrase"
          render={({ field }) => (
            <FormItemLayout
              layout="horizontal"
              label={$t('Private key passphrase')}
              description={$t('Optional passphrase for encrypted private keys')}
            >
              <FormControl>
                <PasswordInput
                  value={field.value ?? ''}
                  type={showPrivateKeyPassphrase ? 'text' : 'password'}
                  placeholder={$t('Optional')}
                  onChange={(event) => field.onChange(event.target.value)}
                  actions={
                    <div className="flex items-center justify-center">
                      <Button
                        variant="default"
                        className="w-7"
                        icon={showPrivateKeyPassphrase ? <Eye /> : <EyeOff />}
                        onClick={() => setShowPrivateKeyPassphrase(!showPrivateKeyPassphrase)}
                      />
                    </div>
                  }
                />
              </FormControl>
            </FormItemLayout>
          )}
        />
      </div>
    </div>
  )
}
