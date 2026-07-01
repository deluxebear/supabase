import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogSectionSeparator,
  DialogTitle,
  DialogTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from 'ui'
import { Admonition } from 'ui-patterns/admonition'

import { DocsButton } from './DocsButton'
import { InlineLinkClassName } from './InlineLink'
import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'
import { ResponseError } from '@/types'

interface HighQueryCostErrorProps {
  error: ResponseError
  suggestions?: string[]
  onSelectLoadData?: () => void
}

export const HighCostError = ({
  error,
  suggestions,
  onSelectLoadData,
}: HighQueryCostErrorProps) => {
  return (
    <Admonition
      type="default"
      title={$t('Data not loaded to protect database performance')}
      description={$t(
        'The query to retrieve the data was not run as it could place heavy load on the database and impact performance'
      )}
    >
      <div className="mt-2 flex items-center gap-x-2 items-center">
        {!!onSelectLoadData && (
          <LoadDataWarningDialog error={error} onSelectLoadData={onSelectLoadData} />
        )}
        <HighQueryCostDialog error={error} suggestions={suggestions} />
      </div>
    </Admonition>
  )
}

const HighQueryCostDialog = ({ error, suggestions = [] }: HighQueryCostErrorProps) => {
  const metadata = error.metadata

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">{$t('Learn more')}</Button>
      </DialogTrigger>
      <DialogContent onOpenAutoFocus={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{$t('Estimated query cost exceeds safety thresholds')}</DialogTitle>
          <DialogDescription>
            {$t('Preventive measure to mitigate impacting the database')}
          </DialogDescription>
        </DialogHeader>
        <DialogSectionSeparator />
        <DialogSection className="flex flex-col gap-y-2 text-sm">
          <p>
            {$t(
              'The dashboard runs optimized SQL queries on your project’s database to load data for this interface.'
            )}
          </p>
          <p>
            {$t('However, the query was skipped as its')}{' '}
            <Tooltip>
              <TooltipTrigger className={InlineLinkClassName}>
                {$t('estimated cost')}
              </TooltipTrigger>
              <TooltipContent side="bottom" className="flex flex-col gap-y-1">
                <p>
                  {$t('Estimated cost:')} {metadata?.cost.toLocaleString()}
                </p>
                <p className="text-foreground-light">
                  {$t('Determined via the')} <code className="text-code-inline">EXPLAIN</code>{' '}
                  command
                </p>
              </TooltipContent>
            </Tooltip>{' '}
            {$t(
              'is high and could place significant load on the database with high disk I/O or CPU usage.'
            )}
          </p>
        </DialogSection>

        {suggestions.length > 0 && (
          <>
            <DialogSectionSeparator />
            <DialogSection className="flex flex-col gap-y-4 text-sm">
              <p className="font-mono text-foreground-lighter uppercase tracking-tight text-sm">
                {$t('Suggested steps')}
              </p>

              {suggestions.length > 0 && (
                <div className="flex flex-col gap-y-1">
                  <p>{$t('You may check the following to lower the cost of the query')}</p>
                  <ul className="list-disc pl-6">
                    {suggestions.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </div>
              )}
            </DialogSection>
          </>
        )}

        <DialogFooter>
          <DocsButton
            href={`${DOCS_URL}/guides/troubleshooting/understanding-postgresql-explain-output-Un9dqX`}
          />
          <DialogClose asChild>
            <Button variant="default" className="opacity-100">
              {$t('Understood')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const LoadDataWarningDialog = ({
  error,
  onSelectLoadData,
}: {
  error: ResponseError
  onSelectLoadData: () => void
}) => {
  const metadata = error.metadata

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="default">{$t('Load data')}</Button>
      </DialogTrigger>
      <DialogContent onOpenAutoFocus={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{$t('Confirm to proceed loading data')}</DialogTitle>
          <DialogDescription>
            {$t('Preventive measure to mitigate impacting the database')}
          </DialogDescription>
        </DialogHeader>
        <DialogSectionSeparator />
        <DialogSection className="flex flex-col gap-y-2 text-sm">
          <p>
            {$t("The query to load your table's data was initially skipped as its")}{' '}
            <Tooltip>
              <TooltipTrigger className={InlineLinkClassName}>
                {$t('estimated cost')}
              </TooltipTrigger>
              <TooltipContent side="bottom" className="flex flex-col gap-y-1">
                <p>
                  {$t('Estimated cost:')} {metadata?.cost.toLocaleString()}
                </p>
                <p className="text-foreground-light">
                  {$t('Determined via the')} <code className="text-code-inline">EXPLAIN</code>{' '}
                  command
                </p>
              </TooltipContent>
            </Tooltip>{' '}
            {$t(
              'is high and could place significant load on the database with high disk I/O or CPU usage.'
            )}
          </p>

          <p>
            {$t(
              "You may proceed to run the query, and we'll suppress this warning for this table for the rest of this browser session."
            )}
          </p>
        </DialogSection>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="default" className="opacity-100">
              {$t('Cancel')}
            </Button>
          </DialogClose>
          <DialogClose asChild>
            <Button variant="warning" onClick={() => onSelectLoadData()}>
              {$t('I understand, proceed')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
