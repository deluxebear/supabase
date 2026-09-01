import { t as $t } from '@/lib/i18n'
import { ReactNode } from 'react'
import { Badge } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { InfoTooltip } from 'ui-patterns/info-tooltip'
import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageSection,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'

import { RuntimeBadge } from '../RuntimeBadge'
import { WorkerCommandLine } from '../WorkerCommandLine'
import { LISTENING_PORT, WORKERS_REGION_LABEL } from '../Workers.constants'
import type { Worker } from '../Workers.types'
import { formatSize, getRuntimeMeta } from '../Workers.utils'
import { buildWorkerCliCommands } from '../workerSnippets'
import { WORKER_CALL_TABS, WorkerSnippetTabs } from '../WorkerSnippetTabs'
import { CLI_NAME } from '@/lib/constants/workers'

interface WorkerOverviewTabProps {
  worker: Worker
}

const InstanceCount = ({
  label,
  value,
  tooltip,
}: {
  label: string
  value: number
  tooltip: ReactNode
}) => (
  <div className="flex flex-col gap-1 px-5 py-4">
    <span className="flex items-center gap-1.5 text-sm text-foreground-light">
      {label}
      <InfoTooltip side="top" className="max-w-56">
        {tooltip}
      </InfoTooltip>
    </span>
    <span className="text-2xl tabular-nums text-foreground">{value}</span>
  </div>
)

const SettingsRow = ({
  label,
  children,
  isFirst,
}: {
  label: string
  children: ReactNode
  isFirst?: boolean
}) => (
  <div
    className={`flex items-center justify-between px-4 py-3 ${
      isFirst ? '' : 'border-t border-default'
    }`}
  >
    <span className="text-sm text-foreground-light">{label}</span>
    <span className="text-sm text-foreground">{children}</span>
  </div>
)

export const WorkerOverviewTab = ({ worker }: WorkerOverviewTabProps) => {
  const runtime = getRuntimeMeta(worker.runtime)
  const commands = buildWorkerCliCommands(worker.name)

  return (
    <PageContainer size="small">
      {worker.buildState === 'failed' && (
        <PageSection>
          <PageSectionContent>
            <Admonition type="destructive" title={$t('This worker failed to build')}>
              <div className="space-y-3">
                <p>{worker.stateReason ?? 'The build did not complete.'}</p>
                <WorkerCommandLine
                  comment="Redeploy after fixing the build"
                  command={`supabase ${CLI_NAME} push ${worker.name}`}
                />
              </div>
            </Admonition>
          </PageSectionContent>
        </PageSection>
      )}

      {worker.instancesError !== undefined && (
        <PageSection>
          <PageSectionContent>
            <Admonition type="warning" title={$t('Instances reported an error')}>
              {worker.instancesError}
            </Admonition>
          </PageSectionContent>
        </PageSection>
      )}

      <PageSection>
        <PageSectionMeta>
          <PageSectionSummary>
            <PageSectionTitle>{$t('Instances')}</PageSectionTitle>
          </PageSectionSummary>
        </PageSectionMeta>
        <PageSectionContent>
          {worker.instances === undefined ? (
            <p className="text-sm text-foreground-light">
              {$t('No instances are running for this worker yet.')}
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-foreground-light">
                <span className="tabular-nums text-foreground">{worker.instances.ready}</span> of{' '}
                <span className="tabular-nums text-foreground">{worker.instances.declared}</span>{' '}
                {$t('instances ready')}
              </p>
              <div className="grid grid-cols-2 divide-x divide-y rounded-md border border-default bg-surface-100 sm:grid-cols-4 sm:divide-y-0">
                <InstanceCount
                  label={$t('Instances')}
                  value={worker.instances.declared}
                  tooltip={$t('The number of instances you configured for this worker.')}
                />
                <InstanceCount
                  label={$t('Live')}
                  value={worker.instances.live}
                  tooltip={$t('Instances currently running.')}
                />
                <InstanceCount
                  label={$t('Ready')}
                  value={worker.instances.ready}
                  tooltip={$t('Instances passing health checks and serving requests.')}
                />
                <InstanceCount
                  label={$t('Stale')}
                  value={worker.instances.stale}
                  tooltip={$t('Instances from a previous deployment, being replaced.')}
                />
              </div>
            </div>
          )}
        </PageSectionContent>
      </PageSection>

      <PageSection>
        <PageSectionMeta>
          <PageSectionSummary>
            <PageSectionTitle>{$t('Container')}</PageSectionTitle>
            <PageSectionDescription>
              {$t('The runtime image and entrypoint resolved for this worker.')}
            </PageSectionDescription>
          </PageSectionSummary>
        </PageSectionMeta>
        <PageSectionContent>
          <div className="rounded-md border border-default bg-surface-100">
            <SettingsRow label={$t('Runtime')} isFirst>
              <RuntimeBadge runtime={worker.runtime} />
            </SettingsRow>
            {worker.imageVersion !== undefined && (
              <SettingsRow label={$t('Version')}>
                <span className="font-mono text-xs text-foreground-light">
                  {worker.imageVersion}
                </span>
              </SettingsRow>
            )}
            {runtime !== undefined && (
              <SettingsRow label={$t('Base image')}>
                <span className="font-mono text-xs text-foreground-light">{runtime.baseImage}</span>
              </SettingsRow>
            )}
            {runtime !== undefined && (
              <SettingsRow label={$t('Entrypoint')}>
                <span className="font-mono text-xs text-foreground-light">
                  {runtime.entrypoint}
                </span>
              </SettingsRow>
            )}
            <SettingsRow label={$t('Listening port')}>
              <span className="font-mono text-xs text-foreground-light">
                {$t('$PORT →')} {LISTENING_PORT}
              </span>
            </SettingsRow>
          </div>
        </PageSectionContent>
      </PageSection>

      <PageSection>
        <PageSectionMeta>
          <PageSectionSummary>
            <PageSectionTitle>{$t('Resources')}</PageSectionTitle>
          </PageSectionSummary>
        </PageSectionMeta>
        <PageSectionContent>
          <div className="rounded-md border border-default bg-surface-100">
            <SettingsRow label={$t('Size')} isFirst>
              {formatSize(worker.size)}
            </SettingsRow>
            <SettingsRow label={$t('Instances')}>{worker.declaredInstances}</SettingsRow>
            <SettingsRow label={$t('Access')}>
              {worker.access === 'public' ? (
                <Badge variant="success">{$t('Public')}</Badge>
              ) : (
                <Badge>{$t('Private')}</Badge>
              )}
            </SettingsRow>
            <SettingsRow label={$t('Region')}>
              <span className="text-foreground-light">
                {WORKERS_REGION_LABEL} <span className="text-foreground-lighter">(locked)</span>
              </span>
            </SettingsRow>
          </div>
        </PageSectionContent>
      </PageSection>

      <PageSection>
        <PageSectionMeta>
          <PageSectionSummary>
            <PageSectionTitle>{$t('How to call')}</PageSectionTitle>
            <PageSectionDescription>
              {$t('Call the worker over its gateway URL.')}
            </PageSectionDescription>
          </PageSectionSummary>
        </PageSectionMeta>
        <PageSectionContent>
          <WorkerSnippetTabs
            input={{
              name: worker.name,
              runtime: worker.runtime,
              size: worker.size,
              access: worker.access,
              instances: worker.declaredInstances,
            }}
            tabs={WORKER_CALL_TABS}
          />
        </PageSectionContent>
      </PageSection>

      <PageSection>
        <PageSectionMeta>
          <PageSectionSummary>
            <PageSectionTitle>{$t('Develop locally')}</PageSectionTitle>
            <PageSectionDescription>
              {$t('Manage this worker from the Supabase CLI.')}
            </PageSectionDescription>
          </PageSectionSummary>
        </PageSectionMeta>
        <PageSectionContent>
          <div className="space-y-4 rounded-md border border-default bg-surface-100 p-4">
            {commands.map((command) => (
              <WorkerCommandLine
                key={command.command}
                comment={command.comment}
                command={command.command}
              />
            ))}
          </div>
        </PageSectionContent>
      </PageSection>
    </PageContainer>
  )
}
