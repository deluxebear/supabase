import { randomUUID } from 'node:crypto'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  AttachmentPreflightFailed,
  CapabilityUnavailable,
  DetachOperationConflict,
  detachProject,
  getProjectAttachmentStatus,
  listProjectCapabilities,
  requireProjectCapability,
  StackAlreadyAttached,
} from '@/lib/api/self-platform/attachment'
import {
  publicProjectEndpointsFromDocument,
  safeLegacyPublicUrl,
} from '@/lib/api/self-platform/endpoint-registry'
import { clearHealthCache } from '@/lib/api/self-platform/health'
import {
  getProjectManagementBinding,
  revokeProjectManagementBinding,
} from '@/lib/api/self-platform/management-trust'
import type { PlatformProjectRow } from '@/lib/api/self-platform/projects'
import {
  listSharedDbChildRefs,
  MISSING_STACK_COLUMN,
  toProjectDetailResponse,
} from '@/lib/api/self-platform/projects'
import {
  parseProjectPatchInput,
  ProbeFailed,
  ProjectRowMissing,
  SharedDbLocked,
  updateProjectConnection,
} from '@/lib/api/self-platform/projects-admin'
import { checkPermission, guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { ProjectNotFound, resolveProjectIdentity } from '@/lib/api/self-platform/resolve-connection'
import { DEFAULT_PROJECT, PROJECT_REST_URL } from '@/lib/constants/api'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (req.method === 'GET') {
    if (!IS_SELF_PLATFORM) {
      // Plain self-hosted: historical stub, unchanged.
      return res
        .status(200)
        .json({ ...DEFAULT_PROJECT, connectionString: '', restUrl: PROJECT_REST_URL })
    }
    const ref = String(req.query.ref)
    if (STUDIO_DEPLOYMENT_PROFILE === 'fleet' && ref === DEFAULT_PROJECT.ref) {
      return res.status(404).json({ message: 'Project not found' })
    }
    try {
      const project = await resolveProjectIdentity(ref)
      // [self-platform] Visibility guard (spec §8): resolver 404 has already won
      // for unknown refs; a resolvable ref the member has no read grant on is 403.
      const canRead = await checkPermission(claims, {
        action: PermissionAction.READ,
        resource: 'projects',
        projectRef: ref,
      })
      if (!canRead) return res.status(403).json({ message: 'Forbidden' })
      // Fleet project metadata is intentionally non-secret. pg-meta credentials
      // are resolved only inside the server-side BFF after this RBAC check.
      const base = project.row
        ? {
            ...toProjectDetailResponse(project.row),
            // [self-platform] M6.1: additive edit-panel prefill block (spec §5).
            self_platform: await buildSelfPlatformBlock(project.row),
          }
        : { ...DEFAULT_PROJECT, restUrl: project.restUrl }
      return res.status(200).json(base)
    } catch (err) {
      if (err instanceof ProjectNotFound)
        return res.status(404).json({ message: 'Project not found' })
      throw err
    }
  }
  if (req.method === 'PATCH') {
    return handlePatch(req, res, claims)
  }
  if (req.method === 'DELETE') {
    return handleDelete(req, res, claims)
  }
  res.setHeader('Allow', IS_SELF_PLATFORM ? ['GET', 'PATCH', 'DELETE'] : ['GET'])
  return res
    .status(405)
    .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
}

// [self-platform] M5.0 spec §5: deregister-ONLY — removes the registry row,
// never touches the real database. Order: ghost 404 (guard resolves first) →
// 403 (Owner-only via the matrix deny) → default-refusal 400 → business.
async function handleDelete(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (
    !IS_SELF_PLATFORM ||
    STUDIO_DEPLOYMENT_PROFILE !== 'fleet' ||
    !STUDIO_CAPABILITIES.projectAttachment
  ) {
    return res.status(404).json({ message: 'Not available on this deployment' })
  }
  if (Array.isArray(req.query.ref)) {
    return res.status(400).json({ message: 'Invalid ref parameter' })
  }
  const ref = String(req.query.ref)
  const ok = await guardProjectRoute(res, claims, {
    action: PermissionAction.DELETE,
    projectRef: ref,
    resource: 'projects',
  })
  if (!ok) return
  if (ref === 'default') {
    return res.status(400).json({ message: 'The default project cannot be detached' })
  }
  try {
    await requireProjectCapability(ref, 'project.detach')
    const actor = claims?.sub ?? 'unknown'
    const correlationId =
      (typeof req.headers['x-correlation-id'] === 'string' && req.headers['x-correlation-id']) ||
      randomUUID()
    if (await getProjectManagementBinding(ref)) {
      await revokeProjectManagementBinding({ projectRef: ref, actor, correlationId })
    }
    const detached = await detachProject({
      projectRef: ref,
      actor,
      correlationId,
    })
    clearHealthCache(ref)
    return res.status(200).json({ ref, ...detached })
  } catch (error) {
    if (error instanceof CapabilityUnavailable) {
      return res.status(409).json({
        code: 'capability_unavailable',
        message: error.message,
        blockers: error.blockers,
      })
    }
    if (error instanceof DetachOperationConflict) {
      return res.status(409).json({ code: 'operation_conflict', message: error.message })
    }
    throw error
  }
}

// [self-platform] M6.1 spec §5: everything the edit panel needs to prefill —
// non-secret fields plaintext, secrets strictly as is-set BOOLEANS. For
// external rows, shared_children powers the propagation warning dialog.
async function buildSelfPlatformBlock(row: PlatformProjectRow) {
  let sharedChildren: string[] = []
  if (row.stack_kind === 'external') {
    try {
      sharedChildren = await listSharedDbChildRefs(row.ref)
    } catch (err) {
      // Pre-M5.0 platform-db: stack columns absent — degrade like projects.ts.
      if (!(err instanceof Error && err.message.includes(MISSING_STACK_COLUMN))) throw err
    }
  }
  const hostRef = (row.stack_meta as Record<string, unknown> | null)?.host_ref
  const [attachment, capabilities] = await Promise.all([
    getProjectAttachmentStatus(row.ref),
    listProjectCapabilities(row.ref),
  ])
  const endpoints = publicProjectEndpointsFromDocument(row.endpoint_document)
  const legacyApiUrl =
    row.endpoint_document === undefined ? safeLegacyPublicUrl(row.kong_url) : null
  const legacyRestUrl =
    row.endpoint_document === undefined ? safeLegacyPublicUrl(row.rest_url) : null
  return {
    stack_kind: row.stack_kind,
    host_ref: typeof hostRef === 'string' ? hostRef : null,
    db_host: endpoints?.directPostgres.host ?? '',
    db_port: endpoints?.directPostgres.port ?? 0,
    db_name: endpoints?.directPostgres.database ?? '',
    db_user: endpoints?.directPostgres.user ?? '',
    db_user_readonly: endpoints?.directPostgres.user ?? '',
    kong_url: endpoints?.apiUrl ?? legacyApiUrl ?? '',
    rest_url: endpoints?.restUrl ?? legacyRestUrl ?? '',
    endpoints,
    key_mode: row.key_mode ?? 'legacy-jwt',
    tls_mode: endpoints?.directPostgres.tlsMode ?? 'prefer',
    tls_ca_reference: row.tls_ca_reference ?? null,
    logflare_url: row.logflare_url ?? null,
    metrics_url: row.metrics_url ?? null,
    container_name: row.container_name ?? null,
    k8s_namespace: row.k8s_namespace ?? null,
    k8s_pod_selector: row.k8s_pod_selector ?? null,
    secrets_set: {
      db_pass: true,
      db_pass_readonly: Boolean(row.db_pass_readonly_enc),
      anon_key: true,
      service_key: true,
      jwt_secret: true,
      publishable_key: row.publishable_key_enc != null,
      secret_key: row.secret_key_enc != null,
      logflare_token: row.logflare_token_enc != null,
      metrics_token: row.metrics_token_enc != null,
    },
    shared_children: sharedChildren,
    attachment,
    capabilities,
  }
}

// [self-platform] M6.1 spec §3/§4: partial registry-row update. Order: plain
// 404 → array-ref 400 → guard (write:Update on 'projects'; ghost 404 wins
// inside the guard) → parse 400s → business (SharedDbLocked/ProbeFailed →
// 400, missing row → 404) → per-ref health-cache invalidation for connection
// changes → 200 detail + propagated_children.
async function handlePatch(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (
    !IS_SELF_PLATFORM ||
    STUDIO_DEPLOYMENT_PROFILE !== 'fleet' ||
    !STUDIO_CAPABILITIES.projectAttachment
  ) {
    return res.status(404).json({ message: 'Not available on this deployment' })
  }
  if (Array.isArray(req.query.ref)) {
    return res.status(400).json({ message: 'Invalid ref parameter' })
  }
  const ref = String(req.query.ref)
  const ok = await guardProjectRoute(res, claims, {
    action: PermissionAction.UPDATE,
    projectRef: ref,
    resource: 'projects',
  })
  if (!ok) return
  const parsed = parseProjectPatchInput(req.body)
  if ('error' in parsed) return res.status(400).json({ message: parsed.error })
  try {
    if (parsed.value.connection !== undefined) {
      await requireProjectCapability(ref, 'project.connection.update')
    }
    const { propagatedChildren } = await updateProjectConnection(ref, parsed.value, {
      actor: claims?.sub ?? 'unknown',
      correlationId:
        (typeof req.headers['x-correlation-id'] === 'string' && req.headers['x-correlation-id']) ||
        randomUUID(),
    })
    if (parsed.value.connection !== undefined) {
      // Spec D4: never leave the OLD stack's probe results on screen.
      clearHealthCache(ref)
      for (const child of propagatedChildren) clearHealthCache(child)
    }
    const project = await resolveProjectIdentity(ref)
    const detail = project.row
      ? toProjectDetailResponse(project.row)
      : { ...DEFAULT_PROJECT, restUrl: project.restUrl }
    return res.status(200).json({ ...detail, propagated_children: propagatedChildren })
  } catch (err) {
    if (err instanceof ProjectRowMissing) {
      return res.status(404).json({ message: 'Project not found' })
    }
    if (err instanceof SharedDbLocked) {
      return res.status(400).json({ message: err.message })
    }
    if (err instanceof ProbeFailed) {
      return res.status(400).json({ message: `Could not connect to database: ${err.message}` })
    }
    if (err instanceof AttachmentPreflightFailed) {
      return res.status(422).json({
        code: 'preflight_failed',
        message: err.message,
        preflight: err.report,
      })
    }
    if (err instanceof StackAlreadyAttached) {
      return res.status(409).json({
        code: 'stack_already_attached',
        message: err.message,
        existing_project_ref: err.existingProjectRef,
      })
    }
    if (err instanceof CapabilityUnavailable) {
      return res.status(409).json({
        code: 'capability_unavailable',
        message: err.message,
        blockers: err.blockers,
      })
    }
    throw err
  }
}
