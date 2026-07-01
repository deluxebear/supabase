import dayjs from 'dayjs'
import { Input, SidePanel, TextArea } from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'

import {
  FormSection,
  FormSectionContent,
  FormSectionLabel,
} from '@/components/ui/Forms/FormSection'
import {
  TIMESTAMP_MICROS_PER_MS,
  type AuditLog,
} from '@/data/organizations/organization-audit-logs-query'
import { t as $t } from '@/lib/i18n'

interface LogDetailsPanelProps {
  selectedLog?: AuditLog
  onClose: () => void
}

export const LogDetailsPanel = ({ selectedLog, onClose }: LogDetailsPanelProps) => {
  const timestamp = selectedLog
    ? dayjs(selectedLog.timestamp / TIMESTAMP_MICROS_PER_MS).format('DD MMM YYYY, HH:mm:ss')
    : ''
  const timestampWithTz = selectedLog
    ? dayjs(selectedLog.timestamp / TIMESTAMP_MICROS_PER_MS).format('DD MMM YYYY, HH:mm:ss (ZZ)')
    : ''

  return (
    <SidePanel
      size="large"
      header={selectedLog ? `"${selectedLog.action.name}" on ${timestamp}` : ''}
      visible={selectedLog !== undefined}
      onCancel={onClose}
      cancelText="Close"
    >
      <FormSection header={<FormSectionLabel>{$t('General')}</FormSectionLabel>}>
        <FormSectionContent loading={false}>
          <FormItemLayout
            label={$t('Occurred at')}
            description={timestampWithTz}
            isReactForm={false}
          >
            <Input
              readOnly
              size="small"
              value={
                selectedLog
                  ? dayjs(selectedLog.timestamp / TIMESTAMP_MICROS_PER_MS).toISOString()
                  : ''
              }
            />
          </FormItemLayout>
          <FormItemLayout label={$t('Request ID')} isReactForm={false}>
            <Input readOnly size="small" value={selectedLog?.request_id ?? ''} />
          </FormItemLayout>
          {selectedLog?.organization_slug && (
            <FormItemLayout label={$t('Organization')} isReactForm={false}>
              <Input readOnly size="small" value={selectedLog.organization_slug} />
            </FormItemLayout>
          )}
          {selectedLog?.project_ref && (
            <FormItemLayout label={$t('Project ref')} isReactForm={false}>
              <Input readOnly size="small" value={selectedLog.project_ref} />
            </FormItemLayout>
          )}
        </FormSectionContent>
      </FormSection>

      <SidePanel.Separator />

      <FormSection header={<FormSectionLabel>{$t('Actor')}</FormSectionLabel>}>
        <FormSectionContent loading={false}>
          <FormItemLayout label={$t('Token type')} isReactForm={false}>
            <Input readOnly size="small" value={selectedLog?.actor.token_type ?? ''} />
          </FormItemLayout>
          {selectedLog?.actor.email && (
            <FormItemLayout label={$t('Email')} isReactForm={false}>
              <Input readOnly size="small" value={selectedLog?.actor.email ?? ''} />
            </FormItemLayout>
          )}
          {selectedLog?.actor.user_id && (
            <FormItemLayout label={$t('User ID')} isReactForm={false}>
              <Input readOnly size="small" value={selectedLog?.actor.user_id ?? ''} />
            </FormItemLayout>
          )}
          {selectedLog?.actor.ip && (
            <FormItemLayout label={$t('IP address')} isReactForm={false}>
              <Input readOnly size="small" value={selectedLog?.actor.ip ?? ''} />
            </FormItemLayout>
          )}
          {selectedLog?.actor.oauth_app_name && (
            <FormItemLayout label={$t('OAuth app')} isReactForm={false}>
              <Input readOnly size="small" value={selectedLog?.actor.oauth_app_name ?? ''} />
            </FormItemLayout>
          )}
          {selectedLog?.actor.app_name && (
            <FormItemLayout label={$t('App')} isReactForm={false}>
              <Input readOnly size="small" value={selectedLog?.actor.app_name ?? ''} />
            </FormItemLayout>
          )}
        </FormSectionContent>
      </FormSection>

      <SidePanel.Separator />

      <FormSection header={<FormSectionLabel>{$t('Action')}</FormSectionLabel>}>
        <FormSectionContent loading={false}>
          <FormItemLayout label={$t('Name')} isReactForm={false}>
            <Input readOnly size="small" value={selectedLog?.action.name ?? ''} />
          </FormItemLayout>
          <FormItemLayout label={$t('Method')} isReactForm={false}>
            <Input readOnly size="small" value={selectedLog?.action.method ?? ''} />
          </FormItemLayout>
          <FormItemLayout label={$t('Route')} isReactForm={false}>
            <Input readOnly size="small" value={selectedLog?.action.route ?? ''} />
          </FormItemLayout>
          <FormItemLayout label={$t('Status')} isReactForm={false}>
            <Input readOnly size="small" value={String(selectedLog?.action.status ?? '')} />
          </FormItemLayout>
          {selectedLog?.action.metadata && (
            <FormItemLayout label={$t('Metadata')} isReactForm={false}>
              <TextArea
                readOnly
                rows={5}
                className="font-mono input-xs"
                value={JSON.stringify(selectedLog.action.metadata, null, 2)}
              />
            </FormItemLayout>
          )}
        </FormSectionContent>
      </FormSection>
    </SidePanel>
  )
}
