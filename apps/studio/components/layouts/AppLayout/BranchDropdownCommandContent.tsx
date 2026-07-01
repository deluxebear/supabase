import { ListTree, MessageCircle, Plus } from 'lucide-react'
import Link from 'next/link'
import {
  Button,
  cn,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  ScrollArea,
} from 'ui'

import { BranchLink } from './BranchLink'
import type { Branch } from '@/data/branches/branches-query'
import { t as $t } from '@/lib/i18n'
import { useTrack } from '@/lib/telemetry/track'

const BRANCHING_GITHUB_DISCUSSION_LINK = 'https://github.com/orgs/supabase/discussions/18937'

export interface BranchDropdownCommandContentProps {
  embedded: boolean
  className?: string
  branchList: Branch[]
  selectedBranch: Branch | undefined
  branchesCount: number
  isBranchingEnabled: boolean
  projectRef: string | undefined
  onClose: () => void
  onCreateBranch: () => void
}

export function BranchDropdownCommandContent({
  embedded,
  className,
  branchList,
  selectedBranch,
  branchesCount,
  isBranchingEnabled,
  projectRef,
  onClose,
  onCreateBranch,
}: BranchDropdownCommandContentProps) {
  const track = useTrack()

  if (embedded) {
    return (
      <Command className={cn(className, 'flex flex-col flex-1 min-h-0 overflow-hidden')}>
        <div className="grid grid-cols-2 gap-2 shrink-0 p-2 border-b">
          <Button
            variant="text"
            size="small"
            asChild
            block
            icon={<ListTree size={14} strokeWidth={1.5} />}
          >
            <Link
              href={`/project/${projectRef}/branches`}
              className="text-xs text-foreground-light hover:text-foreground"
              onClick={onClose}
            >
              {$t('Manage branches')}
            </Link>
          </Button>
          <Button
            variant="text"
            size="small"
            asChild
            block
            icon={<MessageCircle size={14} strokeWidth={1.5} />}
          >
            <a
              target="_blank"
              rel="noreferrer noopener"
              href={BRANCHING_GITHUB_DISCUSSION_LINK}
              onClick={onClose}
              className="text-xs text-foreground-light hover:text-foreground"
            >
              {$t('Branching feedback')}
            </a>
          </Button>
          <Button
            variant="default"
            size="small"
            block
            className="col-span-full text-xs text-foreground-light hover:text-foreground"
            onClick={() => {
              track('branch_selector_create_clicked')
              onClose()
              onCreateBranch()
            }}
            icon={<Plus size={14} strokeWidth={1.5} />}
          >
            {$t('Create branch')}
          </Button>
        </div>
        {isBranchingEnabled && (
          <CommandInput placeholder={$t('Find branch...')} wrapperClassName="shrink-0 border-b" />
        )}
        <CommandList className="flex flex-col flex-1 p-1 min-h-0 overflow-y-auto max-h-none!">
          {isBranchingEnabled && <CommandEmpty>{$t('No branches found')}</CommandEmpty>}
          <CommandGroup className="min-h-0">
            {branchList.map((branch) => (
              <BranchLink
                key={branch.id}
                branch={branch}
                isSelected={branch.id === selectedBranch?.id || branchesCount === 0}
                onClose={onClose}
              />
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    )
  }

  return (
    <Command className={className}>
      {isBranchingEnabled && <CommandInput placeholder={$t('Find branch...')} />}
      <CommandList>
        {isBranchingEnabled && <CommandEmpty>{$t('No branches found')}</CommandEmpty>}
        <CommandGroup>
          <ScrollArea className="max-h-[210px] overflow-y-auto">
            {branchList.map((branch) => (
              <BranchLink
                key={branch.id}
                branch={branch}
                isSelected={branch.id === selectedBranch?.id || branchesCount === 0}
                onClose={onClose}
              />
            ))}
          </ScrollArea>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup>
          <CommandItem
            className="cursor-pointer w-full"
            onSelect={() => {
              track('branch_selector_create_clicked')
              onClose()
              onCreateBranch()
            }}
          >
            <div className="w-full flex items-center gap-2">
              <Plus size={14} strokeWidth={1.5} />
              <p>{$t('Create branch')}</p>
            </div>
          </CommandItem>
          <CommandItem
            className="cursor-pointer w-full"
            onSelect={() => {
              track('branch_selector_manage_clicked')
              onClose()
            }}
          >
            <Link
              href={`/project/${projectRef}/branches`}
              className="w-full flex items-center gap-2"
            >
              <ListTree size={14} strokeWidth={1.5} />
              <p>{$t('Manage branches')}</p>
            </Link>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup>
          <CommandItem
            className="cursor-pointer w-full"
            onSelect={() => {
              onClose()
              window?.open(BRANCHING_GITHUB_DISCUSSION_LINK, '_blank')?.focus()
            }}
            onClick={onClose}
          >
            <a
              target="_blank"
              rel="noreferrer noopener"
              href={BRANCHING_GITHUB_DISCUSSION_LINK}
              onClick={onClose}
              className="w-full flex gap-2"
            >
              <MessageCircle size={14} strokeWidth={1} className="mt-0.5" />
              <div>
                <p>{$t('Branching feedback')}</p>
                <p className="text-lighter">{$t('Join GitHub Discussion')}</p>
              </div>
            </a>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  )
}
