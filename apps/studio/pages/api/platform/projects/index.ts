import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { listAllProjectsV2 } from '@/lib/api/self-platform/list-user-projects'
import { getMemberContext } from '@/lib/api/self-platform/members'
import { parsePaginationParam } from '@/lib/api/self-platform/pagination'
import {
  attachExternalProject,
  createSharedDbProject,
  DuplicateRef,
  InvalidHostStack,
  parseExternalConnectionInput,
  ProbeFailed,
  REF_PATTERN,
  RESERVED_REFS,
} from '@/lib/api/self-platform/projects-admin'
import { guardOrgRoute } from '@/lib/api/self-platform/rbac/enforce'
import { DEFAULT_PROJECT } from '@/lib/constants/api'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// [self-platform] exported for handler-level tests.
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (req.method === 'GET') {
    // Legacy V1 (no Version:2 header, or not self-platform) stays the hardcoded
    // [DEFAULT_PROJECT] array, byte-identical to M1 — it returns BEFORE any
    // claims handling so plain self-hosted never sees a 401 here. The V2 branch
    // is registry-backed (M2) and role-filtered (M3.0).
    const wantsV2 = IS_SELF_PLATFORM && req.headers['version'] === '2'
    if (!wantsV2) {
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
  if (!IS_SELF_PLATFORM) {
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
      const hostRef =
        typeof body.host_ref === 'string' && body.host_ref !== '' ? body.host_ref : 'default'
      const { id } = await createSharedDbProject({
        ref,
        name,
        hostRef,
        organizationId: ctx.orgId,
      })
      return res
        .status(201)
        .json({ id, ref, name, status: 'ACTIVE_HEALTHY', organization_slug: ctx.orgSlug })
    }
    const parsed = parseExternalConnectionInput(body.connection)
    if ('error' in parsed) {
      return res.status(400).json({ message: parsed.error })
    }
    const { id } = await attachExternalProject({
      ref,
      name,
      organizationId: ctx.orgId,
      connection: parsed.value,
    })
    return res
      .status(201)
      .json({ id, ref, name, status: 'ACTIVE_HEALTHY', organization_slug: ctx.orgSlug })
  } catch (err) {
    if (err instanceof DuplicateRef) {
      return res.status(409).json({ message: 'A project with this ref already exists' })
    }
    if (err instanceof InvalidHostStack) {
      return res.status(400).json({ message: err.message })
    }
    if (err instanceof ProbeFailed) {
      return res.status(400).json({ message: `Could not connect to database: ${err.message}` })
    }
    throw err
  }
}
