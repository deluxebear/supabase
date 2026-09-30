import { IS_PLATFORM } from 'common'
import { motion } from 'framer-motion'
import { MoreVertical } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  TableCell,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from 'ui'

import { APIKeyDeleteDialog } from './APIKeyDeleteDialog'
import { ApiKeyPill } from './ApiKeyPill'
import { TextConfirmModal } from '@/components/ui/TextConfirmModalWrapper'
import type { APIKeysData } from '@/data/api-keys/api-keys-query'
import { t as $t } from '@/lib/i18n'

export const APIKeyRow = ({
  apiKey,
  isDeleting,
  isDeleteModalOpen,
  onDelete,
  setKeyToDelete,
}: {
  apiKey: Extract<APIKeysData[number], { type: 'secret' | 'publishable' }>
  isDeleting: boolean
  isDeleteModalOpen: boolean
  onDelete: () => void
  setKeyToDelete: (id: string | null) => void
}) => {
  const MotionTableRow = motion.create(TableRow)
  const isDefaultPublishableKey =
    !IS_PLATFORM &&
    apiKey.type === 'publishable' &&
    apiKey.id === 'publishable' &&
    apiKey.name === 'publishable' &&
    apiKey.description === 'Publishable API key (anon role)'

  return (
    <>
      <MotionTableRow
        layout
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0 }}
        transition={{
          type: 'spring',
          stiffness: 500,
          damping: 50,
          mass: 1,
        }}
      >
        <TableCell className="py-2 w-56">
          <div className="flex flex-col">
            <span className="font-medium">
              {isDefaultPublishableKey ? $t('Publishable key') : apiKey.name}
            </span>
            <div className="text-sm text-foreground-lighter">
              {(isDefaultPublishableKey
                ? $t('Publishable API key (anon role)')
                : apiKey.description) || (
                <span className="text-foreground-muted">{$t('No description')}</span>
              )}
            </div>
          </div>
        </TableCell>

        <TableCell className="py-2">
          <div className="flex flex-row gap-2">
            <ApiKeyPill apiKey={apiKey} />
          </div>
        </TableCell>

        {IS_PLATFORM && (
          <TableCell className="py-2">
            <div className="flex justify-end">
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger className="px-1 focus-visible:outline-hidden" asChild>
                      <Button
                        aria-label={`More actions for API key ${apiKey.name}`}
                        variant="text"
                        size="tiny"
                        icon={
                          <MoreVertical
                            size="14"
                            className="text-foreground-light hover:text-foreground"
                          />
                        }
                      />
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{$t('More actions for API key')}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent className="max-w-40" align="end">
                  <APIKeyDeleteDialog apiKey={apiKey} setKeyToDelete={setKeyToDelete} />
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </TableCell>
        )}
      </MotionTableRow>

      <TextConfirmModal
        visible={isDeleteModalOpen}
        onCancel={() => setKeyToDelete(null)}
        onConfirm={onDelete}
        title={
          apiKey.type === 'secret'
            ? $t('Delete secret API key: {{name}}', { name: apiKey.name })
            : $t('Delete publishable API key: {{name}}', { name: apiKey.name })
        }
        confirmString={apiKey.name}
        confirmLabel={$t('Yes, irreversibly delete this API key')}
        confirmPlaceholder={$t('Type the name of the API key to confirm')}
        loading={isDeleting}
        variant="destructive"
        alert={{
          title: $t('This cannot be undone'),
          description: $t(
            'Make sure all applications and services using it have been updated before deletion. Deletion will cause them to receive HTTP 401 Unauthorized status codes on all Supabase APIs.'
          ),
        }}
      />
    </>
  )
}
