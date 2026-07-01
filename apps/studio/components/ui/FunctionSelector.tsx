import { useParams } from 'common'
import { uniqBy } from 'lodash'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { useState } from 'react'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
} from 'ui'

import {
  DatabaseFunctionsData,
  useDatabaseFunctionsQuery,
} from '@/data/database-functions/database-functions-query'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { t as $t } from '@/lib/i18n'

type DatabaseFunction = DatabaseFunctionsData[number]

interface FunctionSelectorProps {
  className?: string
  size?: 'tiny' | 'small'
  showError?: boolean
  schema?: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  stopScrollPropagation?: boolean
  // used to filter the functions by a criteria
  filterFunction?: (func: DatabaseFunction) => boolean
  noResultsLabel?: React.ReactNode
}

const FunctionSelector = ({
  className,
  size = 'tiny',
  showError = true,
  disabled = false,
  schema,
  value,
  onChange,
  stopScrollPropagation = false,
  filterFunction = () => true,
  noResultsLabel = <span>{$t('No functions found in this schema.')}</span>,
}: FunctionSelectorProps) => {
  const router = useRouter()
  const { ref } = useParams()
  const { data: project } = useSelectedProjectQuery()
  const [open, setOpen] = useState(false)

  const {
    data,
    error,
    isPending: isLoading,
    isError,
    isSuccess,
    refetch,
  } = useDatabaseFunctionsQuery({
    projectRef: project?.ref,
    connectionString: project?.connectionString,
  })

  const filteredFunctions = (data ?? [])
    .filter((func) => schema && func.schema === schema)
    .filter(filterFunction)
  const functions = uniqBy(filteredFunctions, (func) => func.name)

  return (
    <div className={className}>
      {isLoading && (
        <Button variant="default" className="justify-start" block size={size} loading>
          {$t('Loading functions...')}
        </Button>
      )}

      {showError && isError && (
        <Alert variant="warning" className="px-3! py-3!">
          <AlertTitle className="text-xs text-amber-900">
            {$t('Failed to load functions')}
          </AlertTitle>

          <AlertDescription className="text-xs mb-2">
            {$t('Error:')} {error.message}
          </AlertDescription>

          <Button variant="default" size="tiny" onClick={() => refetch()}>
            {$t('Reload functions')}
          </Button>
        </Alert>
      )}

      {isSuccess && (
        <Popover open={open} onOpenChange={setOpen} modal={false}>
          <PopoverTrigger asChild>
            <Button
              size={size}
              disabled={!!disabled}
              variant="default"
              className={`w-full [&>span]:w-full ${size === 'small' ? 'py-1.5' : ''}`}
              iconRight={
                <ChevronsUpDown className="text-foreground-muted" strokeWidth={2} size={14} />
              }
            >
              {value ? (
                <div className="w-full flex gap-1">
                  <p className="text-foreground-lighter">function:</p>
                  <p className="text-foreground">{value}</p>
                </div>
              ) : (
                <div className="w-full flex gap-1">
                  <p className="text-foreground-lighter">{$t('Select a function')}</p>
                </div>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="p-0" side="bottom" align="start" sameWidthAsTrigger>
            <Command>
              <CommandInput placeholder={$t('Search functions...')} />
              <CommandList
                onWheel={stopScrollPropagation ? (event) => event.stopPropagation() : undefined}
              >
                <CommandEmpty>{$t('No functions found')}</CommandEmpty>
                <CommandGroup>
                  <ScrollArea className={(functions || []).length > 7 ? 'h-[210px]' : ''}>
                    {!functions.length && (
                      <CommandItem
                        key="no-function-found"
                        disabled={true}
                        className="flex items-center justify-between space-x-2 w-full"
                      >
                        {noResultsLabel}
                      </CommandItem>
                    )}
                    {functions.map((func) => (
                      <CommandItem
                        key={func.id}
                        value={func.name.replaceAll('"', '')}
                        className="cursor-pointer flex items-center justify-between space-x-2 w-full"
                        onSelect={() => {
                          onChange(func.name)
                          setOpen(false)
                        }}
                        onClick={() => {
                          onChange(func.name)
                          setOpen(false)
                        }}
                      >
                        <span>{func.name}</span>
                        {value === func.name && (
                          <Check className="text-brand" size={14} strokeWidth={2} />
                        )}
                      </CommandItem>
                    ))}
                  </ScrollArea>
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    className="cursor-pointer w-full"
                    onSelect={() => {
                      setOpen(false)
                      router.push(`/project/${ref}/database/functions`)
                    }}
                    onClick={() => setOpen(false)}
                  >
                    <Link
                      href={`/project/${ref}/database/functions`}
                      onClick={() => {
                        setOpen(false)
                      }}
                      className="w-full flex items-center gap-2"
                    >
                      <Plus size={14} strokeWidth={1.5} />
                      <p>{$t('New function')}</p>
                    </Link>
                  </CommandItem>
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}

export default FunctionSelector
