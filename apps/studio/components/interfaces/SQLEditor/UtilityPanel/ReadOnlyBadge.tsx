import { Badge } from 'ui'

import { t as $t } from '@/lib/i18n'
import { useProfile } from '@/lib/profile'
import { useSqlEditorV2StateSnapshot } from '@/state/sql-editor-v2'
import { isSnippetOwner } from '@/state/sql-editor/sql-editor-rules'

export type ReadOnlyBadgeProps = { id: string }
const ReadOnlyBadge = ({ id }: ReadOnlyBadgeProps) => {
  const { profile } = useProfile()
  const snapV2 = useSqlEditorV2StateSnapshot()

  const snippet = snapV2.snippets[id]
  const snippetIsOwned = !!snippet && isSnippetOwner(snippet.snippet, profile?.id)

  return <>{snippetIsOwned ? null : <Badge>{$t('Read-only')}</Badge>}</>
}

export default ReadOnlyBadge
