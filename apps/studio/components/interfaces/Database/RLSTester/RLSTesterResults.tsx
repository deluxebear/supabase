import { t as $t } from '@/lib/i18n';
import {
  Badge,
  cn,
  Tabs_Shadcn_,
  TabsContent_Shadcn_,
  TabsList_Shadcn_,
  TabsTrigger_Shadcn_,
} from 'ui'
import { Admonition } from 'ui-patterns/admonition'

import { Results } from '../../SQLEditor/UtilityPanel/Results'
import { RLSTableCard } from './RLSTableCard'
import { ParseQueryResults } from './RLSTester.types'
import { deriveRLSTestState } from './RLSTesterResults.utils'
import { useTestQueryRLS } from './useTestQueryRLS'
import type { Policy } from '@/components/interfaces/Database/Policies/PolicyTableRow/PolicyTableRow.utils'
import { type QueryResponseError } from '@/data/sql/execute-sql-mutation'

interface RLSTesterResultsProps {
  results: Object[]
  autoLimit: boolean
  parseQueryResults: ParseQueryResults
  executeSqlError: Error | QueryResponseError | null | undefined
  handleSelectEditPolicy: (policy: Policy) => void
}

export const RLSTesterResults = ({
  results,
  autoLimit,
  parseQueryResults,
  executeSqlError,
  handleSelectEditPolicy,
}: RLSTesterResultsProps) => {
  const { limit } = useTestQueryRLS()

  const {
    isServiceRole,
    tableWithRLSEnabledButNoPolicies,
    tableWithRLSEnabledWithPolicyFalse,
    tableWithRLSEnabledWithPoliciesDontApply,
    noAccessToData,
  } = deriveRLSTestState(parseQueryResults)

  const { operation, role } = parseQueryResults
  const rlsBlockInsert = executeSqlError && operation === 'INSERT'
  const noAccess = noAccessToData || rlsBlockInsert

  return (
    <div className="p-5 pt-4">
      <div className="flex items-center gap-x-2 mb-2">
        <p className="text-sm">{$t('Summary')}</p>
        {noAccess ? (
          <Badge variant="destructive">{$t('No access')}</Badge>
        ) : (
          <Badge variant="success">{results.length > 0 ? 'Can access' : 'Has access'}</Badge>
        )}
      </div>

      <Tabs_Shadcn_ defaultValue="policies">
        <TabsList_Shadcn_ className="gap-x-3">
          <TabsTrigger_Shadcn_ value="policies" className="px-2">
            
                                  {$t('Policies applied')}
                                </TabsTrigger_Shadcn_>
          <TabsTrigger_Shadcn_ value="data" className="px-2" disabled={operation !== 'SELECT'}>
            
                                  {$t('Data preview')}
                                </TabsTrigger_Shadcn_>
        </TabsList_Shadcn_>

        {!!parseQueryResults && (
          <div className="border rounded-sm flex items-center justify-between px-3 py-1.5 mt-3">
            <div className="flex items-center gap-x-2">
              <p className="text-xs text-foreground-light">{$t('Ran as')}</p>
              {!parseQueryResults.role ? (
                <code className="text-code-inline">postgres</code>
              ) : parseQueryResults.user ? (
                <p className="text-sm truncate max-w-52">{parseQueryResults.user.email}</p>
              ) : parseQueryResults.role === 'anon' ? (
                <p className="text-xs">{$t('an Anonymous user')}</p>
              ) : null}
            </div>

            {parseQueryResults.role === 'anon' && (
              <p className="text-foreground-light text-xs">{$t('Not logged in user')}</p>
            )}
            {!!parseQueryResults.user && (
              <code className="text-code-inline">{$t('ID:')} {parseQueryResults.user.id}</code>
            )}
          </div>
        )}

        <TabsContent_Shadcn_ value="policies" className="mt-0">
          {!isServiceRole &&
            (!!tableWithRLSEnabledButNoPolicies ? (
              <Admonition showIcon={false} type="default" className="rounded-sm mt-2">
                <p className="mb-0.5! text-foreground">
                  
                                                {$t('This user')}{' '}
                  {operation === 'SELECT'
                    ? 'has no access to any rows'
                    : `is unable to ${operation?.toLowerCase()} any rows`}{' '}
                  
                                                {$t('from this query')}
                                              </p>
                <p className="text-foreground-light">
                  
                                                {$t('The table')}{' '}
                  <code className="text-code-inline">
                    {tableWithRLSEnabledButNoPolicies.schema}.
                    {tableWithRLSEnabledButNoPolicies.table}
                  </code>{' '}
                  
                                                {$t('has RLS enabled but no policies set up for the')}{' '}
                  <code className="text-code-inline break-keep!">{parseQueryResults.role}</code>{' '}
                  role.
                </p>
              </Admonition>
            ) : tableWithRLSEnabledWithPolicyFalse ? (
              <Admonition showIcon={false} type="default" className="rounded-sm mt-2">
                <p className="mb-0.5! text-foreground">
                  
                                                    {$t('This user has no access to any rows from this query')}
                                                  </p>
                <p className="text-foreground-light">
                  
                                                    {$t('The table')}{' '}
                  <code className="text-code-inline">
                    {tableWithRLSEnabledWithPolicyFalse.schema}.
                    {tableWithRLSEnabledWithPolicyFalse.table}
                  </code>{' '}
                  
                                                    {$t('has a policy that evaluates to')}
                                                    <code className="text-code-inline break-keep!">false</code>  {$t('for the')}{' '}
                  <code className="text-code-inline break-keep!">{parseQueryResults.role}</code>{' '}
                  role.
                </p>
              </Admonition>
            ) : rlsBlockInsert &&
              parseQueryResults.user &&
              tableWithRLSEnabledWithPoliciesDontApply ? (
              <Admonition showIcon={false} type="default" className="rounded-sm mt-2">
                <p className="mb-0.5! text-foreground">
                  
                                                            {$t('This user is unable to')} {operation?.toLowerCase()}  {$t('any rows from this query')}
                                                          </p>
                <p className="text-foreground-light">
                  
                                                            {$t('The table')}{' '}
                  <code className="text-code-inline">
                    {tableWithRLSEnabledWithPoliciesDontApply.schema}.
                    {tableWithRLSEnabledWithPoliciesDontApply.table}
                  </code>{' '}
                  
                                                            {$t('has a policy for the')}{' '}
                  <code className="text-code-inline break-keep!">{parseQueryResults.role}</code>{' '}
                  
                                                            {$t('role, but its condition wasn\'t satisfied for this specific request.')}
                                                          </p>
              </Admonition>
            ) : null)}

          {isServiceRole && (
            <Admonition showIcon={false} type="default" className="rounded-sm mt-2">
              <p className="mb-0.5! text-foreground">
                
                                              {$t('The')} <code className="text-code-inline">postgres</code>  {$t('role has access to all rows for this query')}
                                            </p>
              <p className="text-foreground-light">
                
                                              {$t('The')} <code className="text-code-inline">postgres</code>  {$t('role has admin privileges and bypasses all RLS policies.')}
                                            </p>
            </Admonition>
          )}

          <div className="flex flex-col gap-y-2 mt-4">
            <p className="text-sm">{$t('Table access')}</p>
            {!isServiceRole && (
              <div className="flex flex-col gap-y-2">
                {parseQueryResults?.tables.map((x) => {
                  const { schema, table, tablePolicies, isRLSEnabled } = x
                  return (
                    <RLSTableCard
                      key={`${schema}.${table}`}
                      table={{ schema, name: table, isRLSEnabled }}
                      role={role}
                      operation={operation}
                      policies={tablePolicies}
                      hasError={!!executeSqlError}
                      handleSelectEditPolicy={handleSelectEditPolicy}
                    />
                  )
                })}
              </div>
            )}
          </div>
        </TabsContent_Shadcn_>
        <TabsContent_Shadcn_ value="data" className="mt-2">
          <div
            className={cn(
              'grow flex flex-col border overflow-hidden',
              results.length === 0 ? 'rounded-sm h-32' : 'rounded-t h-56'
            )}
          >
            <Results rows={results} />
          </div>
          {results.length > 0 && (
            <p className="border border-t-0 rounded-b font-mono text-xs text-foreground-light p-2">
              {results.length} row{results.length > 1 ? 's' : ''}
              {autoLimit && results.length >= limit && ` (Limited to only ${limit} rows)`}
            </p>
          )}
        </TabsContent_Shadcn_>
      </Tabs_Shadcn_>
    </div>
  )
}
