import { randomUUID } from 'node:crypto'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { AttachmentPreflightFailed, StackAlreadyAttached } from '@/lib/api/self-platform/attachment'
import { validatePublicProjectEndpoints } from '@/lib/api/self-platform/endpoint-registry'
import { listAllProjectsV2 } from '@/lib/api/self-platform/list-user-projects'
import { getMemberContext } from '@/lib/api/self-platform/members'
import { parsePaginationParam } from '@/lib/api/self-platform/pagination'
import {
  attachExternalProject,
  DuplicateRef,
  parseExternalConnectionInput,
  ProbeFailed,
  REF_PATTERN,
  RESERVED_REFS,
  stageExternalProject,
} from '@/lib/api/self-platform/projects-admin'
import { guardOrgRoute } from '@/lib/api/self-platform/rbac/enforce'
import { DEFAULT_PROJECT } from '@/lib/constants/api'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// [self-platform] exported for handler-level tests.
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (req.method === 'GET') {
    // Plain embedded Studio keeps the historical hardcoded [DEFAULT_PROJECT]
    // response. Fleet is always registry-backed, even for legacy clients that
    // omit Version:2, so its control plane cannot appear as a managed project.
    const wantsRegistryProjects =
      IS_SELF_PLATFORM && (STUDIO_DEPLOYMENT_PROFILE === 'fleet' || req.headers['version'] === '2')
    if (!wantsRegistryProjects) {
      return res.status(200).json([DEFAULT_PROJECT])
    }

    const limit = parsePaginationParam(req.query.limit, 100, 1000)
    const offset = parsePaginationParam(req.query.offset, 0)
    if (limit === null || offset === null) {
      return res.status(400).json({ message: 'Invalid pagination parameters' })
    }

    const gotrueId = claims?.sub
    if (!gotrueId) {
      return res.status(401).json({ message: 'Unauthorized: missing token claims' })
    }
    const ctx = await getMemberContext(gotrueId)
    const result = await listAllProjectsV2(ctx, limit, offset)
    return res.status(200).json(result)
  }
  if (req.method === 'POST') {
    return handleCreate(req, res, claims)
  }
  // Plain mode advertises GET only (POST is a self-platform feature).
  res.setHeader('Allow', IS_SELF_PLATFORM ? ['GET', 'POST'] : ['GET'])
  return res
    .status(405)
    .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
}

// [self-platform] M5.0 spec §4. Body validation runs BEFORE the guard —
// recorded order deviation (M3.1 precedent): the guard needs
// organization_slug from the body.
async function handleCreate(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (
    !IS_SELF_PLATFORM ||
    STUDIO_DEPLOYMENT_PROFILE !== 'fleet' ||
    !STUDIO_CAPABILITIES.projectAttachment
  ) {
    return res.status(404).json({ message: 'Not available on this deployment' })
  }
  const body = (req.body ?? {}) as Record<string, unknown>
  const mode = body.mode
  if (mode !== 'shared-db' && mode !== 'external') {
    return res.status(400).json({ message: 'Invalid mode: expected "shared-db" or "external"' })
  }
  const organizationSlug = typeof body.organization_slug === 'string' ? body.organization_slug : ''
  if (!organizationSlug) {
    return res.status(400).json({ message: 'organization_slug is required' })
  }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 64) {
    return res.status(400).json({ message: 'name is required (max 64 characters)' })
  }
  const ref = typeof body.ref === 'string' ? body.ref : ''
  if (!REF_PATTERN.test(ref)) {
    return res.status(400).json({
      message: 'Invalid ref: 3-30 chars, lowercase letters/digits/hyphens, starts with a letter',
    })
  }
  if (RESERVED_REFS.has(ref)) {
    return res.status(400).json({ message: `"${ref}" is a reserved ref` })
  }

  const ctx = await guardOrgRoute(res, claims, {
    slug: organizationSlug,
    action: PermissionAction.CREATE,
    resource: 'projects',
  })
  if (!ctx) return

  try {
    if (mode === 'shared-db') {
      return res.status(400).json({
        code: 'validation_failed',
        message:
          'Shared-database project creation is incompatible with one-project-per-stack attachment. Attach an independent stack instead.',
      })
    }
    const parsed = parseExternalConnectionInput(body.connection)
    if ('error' in parsed) {
      return res.status(400).json({ message: parsed.error })
    }
    const correlationId =
      (typeof req.headers['x-correlation-id'] === 'string' && req.headers['x-correlation-id']) ||
      randomUUID()
    const isStaged = body.attachment_mode === 'staged'
    let publicEndpoints
    if (isStaged) {
      try {
        publicEndpoints = validatePublicProjectEndpoints(body.public_endpoints)
      } catch (error) {
        return res.status(400).json({
          code: 'validation_failed',
          message:
            error instanceof Error ? error.message : 'Public endpoint configuration is invalid',
        })
      }
    }
    const { id, connectionRevision, preflight } = isStaged
      ? await stageExternalProject({
          ref,
          name,
          organizationId: ctx.orgId,
          connection: parsed.value,
          publicEndpoints: publicEndpoints!,
          actor: claims?.sub ?? 'unknown',
          correlationId,
        })
      : await attachExternalProject({
          ref,
          name,
          organizationId: ctx.orgId,
          connection: parsed.value,
          actor: claims?.sub ?? 'unknown',
          correlationId,
        })
    return res.status(201).json({
      id,
      ref,
      name,
      status: isStaged ? 'COMING_UP' : 'ACTIVE_HEALTHY',
      attachment_state: isStaged ? 'validating' : 'active',
      connection_revision: connectionRevision,
      preflight,
      organization_slug: ctx.orgSlug,
    })
  } catch (err) {
    if (err instanceof DuplicateRef) {
      return res.status(409).json({ message: 'A project with this ref already exists' })
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
    throw err
  }
}
