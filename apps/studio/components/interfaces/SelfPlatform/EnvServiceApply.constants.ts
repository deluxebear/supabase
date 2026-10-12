import type { EnvApplyService } from '@/data/config/env-service-apply'

// Product names shown in the apply notice and dialog.
export const ENV_SERVICE_NAMES: Record<EnvApplyService, string> = {
  postgrest: 'PostgREST',
  storage: 'Storage',
}
