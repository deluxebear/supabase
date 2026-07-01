import { Admonition } from 'ui-patterns/admonition'

import { t as $t } from '@/lib/i18n'

export const BackupsStorageAlert = () => {
  return (
    <Admonition
      type="default"
      layout="horizontal"
      title={$t('Storage objects are not included')}
      description={$t(
        'Database backups do not include objects stored via the Storage API, as the database only\n        includes metadata about these objects. Restoring an old backup does not restore objects that\n        have been deleted since then.'
      )}
    />
  )
}
