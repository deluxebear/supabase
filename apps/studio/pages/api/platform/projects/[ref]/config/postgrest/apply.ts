// [self-platform] Phase 2: apply stored PostgREST settings to the Fleet-managed
// `rest` service. See env-service-apply-route.ts.
import { PermissionAction } from '@supabase/shared-types/out/constants'

import { createEnvServiceApplyRoute } from '@/lib/api/self-platform/env-service-apply-route'
import { POSTGREST_APPLY } from '@/lib/api/self-platform/postgrest-apply'

const { route, handler } = createEnvServiceApplyRoute({
  definition: POSTGREST_APPLY,
  permissions: {
    read: { action: PermissionAction.READ, resource: 'custom_config_postgrest' },
    write: { action: PermissionAction.UPDATE, resource: 'custom_config_postgrest' },
  },
})

export { handler }
export default route
