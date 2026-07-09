import { useParams } from 'common/hooks/useParams'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { Button } from 'ui'
import { Admonition } from 'ui-patterns/admonition'

import { SQLEditor } from '@/components/interfaces/SQLEditor/SQLEditor'
import { generateSnippetTitle } from '@/components/interfaces/SQLEditor/SQLEditor.constants'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { EditorBaseLayout } from '@/components/layouts/editors/EditorBaseLayout'
import { useEditorType } from '@/components/layouts/editors/EditorsLayout.hooks'
import SQLEditorLayout from '@/components/layouts/SQLEditorLayout/SQLEditorLayout'
import { SQLEditorMenu } from '@/components/layouts/SQLEditorLayout/SQLEditorMenu'
import { useSqlSnippetByIdQuery } from '@/data/content/content-id-query'
import { useDashboardHistory } from '@/hooks/misc/useDashboardHistory'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { IS_PLATFORM } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'
import { wasNeverPersisted } from '@/state/sql-editor/sql-editor-lifecycle'
import { useSnippets, useSqlEditorV2StateSnapshot } from '@/state/sql-editor/sql-editor-state'
import { createTabId, useTabsStateSnapshot } from '@/state/tabs'
import type { NextPageWithLayout } from '@/types'

const SqlEditor: NextPageWithLayout = () => {
  const router = useRouter()
  const { id, ref, content, skip } = useParams()
  const { data: project } = useSelectedProjectQuery()

  const editor = useEditorType()
  const tabs = useTabsStateSnapshot()
  const snapV2 = useSqlEditorV2StateSnapshot()
  const { history, setLastVisitedSnippet, clearSnippetsFromHistory } = useDashboardHistory()

  const allSnippets = useSnippets(ref!)
  const snippet = allSnippets.find((x) => x.id === id)

  const tabId = !!id ? tabs.openTabs.find((x) => x.endsWith(id)) : undefined

  // [Joshen] May need to investigate separately, but occasionally addSnippet doesnt exist in
  // the snapV2 valtio store for some reason hence why the added typeof check here
  const canFetchContentBasedOnId = Boolean(
    id !== 'new' && typeof snapV2.addSnippet === 'function' && !wasNeverPersisted(snippet?.status)
  )
  const { data, error, isError } = useSqlSnippetByIdQuery(
    { projectRef: ref, id },
    {
      // A snippet created locally (e.g. from a Template/Example card) is persisted
      // asynchronously. Right after it's marked saved, the content GET can 404
      // briefly because of replication lag before the write is readable. Retry
      // 404s a few times so a freshly-created snippet isn't mistaken for a deleted
      // one and bounced back to /new. A genuinely deleted snippet keeps 404-ing and
      // surfaces after the retries are exhausted.
      retry: (failureCount, err) => (err as { code?: number })?.code === 404 && failureCount < 3,
      retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 3000),
      enabled: canFetchContentBasedOnId,
    }
  )

  const snippetMissing =
    isError && error.code === 404 && error.message.includes('Content not found')
  const invalidId = isError && error.code === 400 && error.message.includes('Invalid uuid')

  // Only treat a content 404 as a real deletion when the snippet is NOT in our
  // local store. If it IS present (the Private/Shared list, or one freshly created
  // from a Template/Examples card), render it from local state instead of nuking it
  // and bouncing to /new. Content GETs can 404 — transiently from replication lag,
  // or persistently on some self-hosted/platform deployments — but a snippet we
  // already hold locally is not "deleted", and redirecting loses the user's work
  // (and tears down the Monaco editor mid-flight → "Canceled" errors).
  // Original context: https://github.com/supabase/supabase/pull/39389
  const isSnippetDeleted = snippetMissing && !snippet

  useEffect(() => {
    if (ref && data && project) {
      // [Joshen] Check if snippet belongs to the current project
      if (!IS_PLATFORM || data.project_id === project.id) {
        snapV2.setSnippet(ref, data)
      } else {
        setLastVisitedSnippet(undefined)
        router.replace(`/project/${ref}/sql/new`)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, data, project])

  // Load the last visited snippet when landing on /new
  useEffect(() => {
    if (
      id === 'new' &&
      skip !== 'true' && // [Joshen] Skip flag implies to skip loading the last visited snippet
      history.sql !== undefined &&
      content === undefined
    ) {
      const snippet = allSnippets.find((snippet) => snippet.id === history.sql)
      if (snippet !== undefined) router.replace(`/project/${ref}/sql/${history.sql}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, allSnippets, content])

  // Watch for route changes
  useEffect(() => {
    if (!router.isReady || !id || id === 'new') return

    const tabId = createTabId('sql', { id })
    const snippet = allSnippets.find((x) => x.id === id)

    tabs.addTab({
      id: tabId,
      type: 'sql',
      label: snippet?.name || generateSnippetTitle(),
      metadata: {
        sqlId: id,
        name: snippet?.name,
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, id])

  // The snippet no longer exists (e.g. deleted from another tab or session): clean up
  // any stale tab and dashboard history references so navigation doesn't resurrect it,
  // then fall back to a new snippet instead of rendering a dead state
  useEffect(() => {
    if (!ref || !id || id === 'new') return
    if (!isSnippetDeleted) return

    const staleTabId = createTabId('sql', { id })
    if (tabs.hasTab(staleTabId)) tabs.removeTab(staleTabId)
    if (snippet !== undefined) snapV2.removeSnippet(id)
    clearSnippetsFromHistory([id])

    toast(`The SQL snippet you were trying to open no longer exists. Opened a new query instead.`)
    router.replace(`/project/${ref}/sql/new`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSnippetDeleted, id, ref])

  // Render nothing while the effect above redirects away from the deleted snippet
  if (isSnippetDeleted) {
    return null
  }

  if (invalidId) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-[400px]">
          <Admonition
            type="default"
            title={`Unable to find snippet with ID ${id}`}
            description={$t("This snippet doesn't exist in your project")}
          >
            {!!tabId ? (
              <Button
                variant="default"
                className="mt-2"
                onClick={() => {
                  tabs.handleTabClose({
                    id: tabId,
                    router,
                    editor,
                    onClearDashboardHistory: () => setLastVisitedSnippet(undefined),
                  })
                }}
              >
                {$t('Close tab')}
              </Button>
            ) : (
              <Button
                asChild
                variant="default"
                className="mt-2"
                onClick={() => setLastVisitedSnippet(undefined)}
              >
                <Link href={`/project/${ref}/sql`}>{$t('Head back')}</Link>
              </Button>
            )}
          </Admonition>
        </div>
      </div>
    )
  }

  return <SQLEditor />
}

SqlEditor.getLayout = (page) => (
  <DefaultLayout>
    <EditorBaseLayout productMenu={<SQLEditorMenu />} product="SQL Editor">
      <SQLEditorLayout>{page}</SQLEditorLayout>
    </EditorBaseLayout>
  </DefaultLayout>
)

export default SqlEditor
