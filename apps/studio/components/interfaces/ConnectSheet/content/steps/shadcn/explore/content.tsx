import { ExternalLink } from 'lucide-react'
import { Button } from 'ui'

import type { StepContentProps } from '@/components/interfaces/ConnectSheet/Connect.types'
import { t as $t } from '@/lib/i18n'

function ShadcnExploreContent(_props: StepContentProps) {
  return (
    <Button asChild variant="default" icon={<ExternalLink size={14} />}>
      <a href="https://supabase.com/ui" target="_blank" rel="noreferrer">
        {$t('Explore supabase.com/ui')}
      </a>
    </Button>
  )
}

export default ShadcnExploreContent
