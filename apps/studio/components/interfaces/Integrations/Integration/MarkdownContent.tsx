import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { cn } from 'ui'

import { Markdown } from '@/components/interfaces/Markdown'
import { t as $t } from '@/lib/i18n'
import { loadIntegrationOverview } from '@/static-data/integrations/overviews'

const CHAR_LIMIT = 500 // Adjust this number as needed

export const MarkdownContent = ({
  integrationId,
  initiallyExpanded,
}: {
  integrationId: string
  initiallyExpanded?: boolean
}) => {
  const [content, setContent] = useState<string>('')
  const [isExpanded, setIsExpanded] = useState(initiallyExpanded ?? false)

  useEffect(() => {
    let cancelled = false
    loadIntegrationOverview(integrationId)
      .then((markdown) => {
        if (!cancelled && markdown !== null) setContent(markdown)
      })
      .catch((error) => console.error('Error loading markdown:', error))

    return () => {
      cancelled = true
    }
  }, [integrationId])

  // Translate the full English overview first so expanded/collapsed slices stay consistent.
  const translatedContent = content.length > 0 ? $t(content.trim()) : ''
  const displayContent = isExpanded
    ? translatedContent
    : translatedContent.slice(0, CHAR_LIMIT)
  const supportExpanding =
    translatedContent.length > CHAR_LIMIT || (translatedContent.match(/\n/g) || []).length > 1

  if (displayContent.length === 0) return null

  return (
    <div className="px-10">
      <div className="relative">
        <motion.div
          initial={false}
          animate={{ height: isExpanded ? 'auto' : 80 }}
          className="overflow-hidden"
          transition={{ duration: 0.4 }}
        >
          <Markdown content={displayContent} className="max-w-3xl!" />
        </motion.div>
        {!isExpanded && (
          <div
            className={cn(
              'bottom-0 left-0 right-0 h-24',
              supportExpanding && 'bg-linear-to-t from-background-200 to-transparent',
              !isExpanded ? 'absolute' : 'relative'
            )}
          />
        )}
        {supportExpanding && (
          <div className={cn('bottom-0', !isExpanded ? 'absolute' : 'relative mt-3')}>
            <button
              className="text-foreground-light hover:text-foreground underline text-sm"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded ? $t('Show less') : $t('Read more')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
