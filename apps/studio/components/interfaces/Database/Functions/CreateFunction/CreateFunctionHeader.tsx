import { SheetHeader, SheetTitle } from 'ui'

import { t as $t } from '@/lib/i18n'

interface CreateFunctionHeaderProps {
  selectedFunction?: string
  isDuplicating?: boolean
}

export const CreateFunctionHeader = ({
  selectedFunction,
  isDuplicating,
}: CreateFunctionHeaderProps) => {
  return (
    <SheetHeader className="py-3 flex flex-row justify-between items-center border-b-0">
      <div className="flex flex-row gap-3 items-center max-w-[75%]">
        <SheetTitle className="truncate">
          {selectedFunction !== undefined ? (
            isDuplicating ? (
              <>
                {$t('Duplicate')}{' '}
                <code className="text-code-inline text-sm">{selectedFunction}</code>
              </>
            ) : (
              <>
                {$t('Edit')} <code className="text-code-inline text-sm">{selectedFunction}</code>
              </>
            )
          ) : (
            $t('Add a new function')
          )}
        </SheetTitle>
      </div>
    </SheetHeader>
  )
}
