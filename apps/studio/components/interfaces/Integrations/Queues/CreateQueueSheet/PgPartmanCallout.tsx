import { useState } from 'react'
import { Button } from 'ui'
import { Admonition } from 'ui-patterns/admonition'

import { usePgPartmanStatus } from '../usePgPartmanStatus'
import { EnableExtensionModal } from '@/components/interfaces/Database/Extensions/EnableExtensionModal'
import { t as $t } from '@/lib/i18n'

export function PgPartmanCallout() {
  const { pgPartmanExtension, isAvailable, isInstalled } = usePgPartmanStatus()
  const [showEnableModal, setShowEnableModal] = useState(false)

  if (!isAvailable || isInstalled) return null

  return (
    <div className="mx-5 my-2">
      <Admonition
        type="tip"
        title={$t('pg_partman is now available')}
        description={$t(
          'Unlock partitioned queues for automatic data retention, lower storage costs, and faster performance at scale.'
        )}
      >
        <Button
          variant="default"
          size="tiny"
          className="mt-2"
          onClick={() => setShowEnableModal(true)}
        >
          {$t('Enable pg_partman')}
        </Button>
      </Admonition>
      {pgPartmanExtension && (
        <EnableExtensionModal
          visible={showEnableModal}
          extension={pgPartmanExtension}
          onCancel={() => setShowEnableModal(false)}
        />
      )}
    </div>
  )
}
