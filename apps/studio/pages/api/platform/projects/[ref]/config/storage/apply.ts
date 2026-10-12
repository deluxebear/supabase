// [self-platform] Phase 2: apply stored Storage settings to the Fleet-managed
// `storage` service. See env-service-apply-route.ts.
import { PermissionAction } from '@supabase/shared-types/out/constants'

import { createEnvServiceApplyRoute } from '@/lib/api/self-platform/env-service-apply-route'
import { STORAGE_APPLY } from '@/lib/api/self-platform/storage-apply'

const { route, handler } = createEnvServiceApplyRoute({
  definition: STORAGE_APPLY,
  permissions: {
    read: { action: PermissionAction.STORAGE_ADMIN_READ },
    write: { action: PermissionAction.STORAGE_ADMIN_WRITE },
  },
})

export { handler }
export default route
