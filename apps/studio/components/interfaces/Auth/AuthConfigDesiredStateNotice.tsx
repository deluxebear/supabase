import { Admonition } from 'ui-patterns/Admonition'

import { t as $t } from '@/lib/i18n'

// [self-platform] Fleet stores Auth settings as desired state only: GoTrue reads
// its configuration at boot and nothing applies the stored settings yet. Shown
// on Auth configuration pages so a save is never read as a live change.
export const AuthConfigDesiredStateNotice = () => (
  <Admonition
    type="warning"
    className="rounded-none border-x-0 border-t-0 px-6"
    title={$t('Auth settings are saved but not applied')}
  >
    <p className="leading-normal!">
      {$t(
        "Fleet stores these settings for this project, but the project's Auth service keeps running with its current configuration. To change it now, update the Auth environment on the managed stack and restart the Auth service."
      )}
    </p>
  </Admonition>
)
