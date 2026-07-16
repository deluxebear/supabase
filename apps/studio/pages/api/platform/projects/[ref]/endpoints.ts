import { randomUUID } from 'node:crypto'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'
import { z } from 'zod'

import apiWrapper from '@/lib/api/apiWrapper'
import { CapabilityUnavailable, requireProjectCapability } from '@/lib/api/self-platform/attachment'
import {
  EndpointRegistryMissing,
  EndpointRevisionConflict,
  getProjectEndpointRegistry,
  publicProjectEndpointsSchema,
  updateProjectEndpointRegistry,
} from '@/lib/api/self-platform/endpoint-registry'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'

const updateSchema = z.object({
  expectedRevision: z.number().int().positive(),
  endpoints: publicProjectEndpointsSchema,
})

function isAvailable() {
  return STUDIO_DEPLOYMENT_PROFILE === 'fleet' && STUDIO_CAPABILITIES.projectAttachment
}

export default function route(req: NextApiRequest, res: NextApiResponse) {
  if (!isAvailable())
    return res.status(404).json({ code: 'project_not_found', message: 'Not found' })
  return apiWrapper(req, res, handler, { withAuth: true })
}

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (!isAvailable())
    return res.status(404).json({ code: 'project_not_found', message: 'Not found' })
  if (Array.isArray(req.query.ref)) {
    return res.status(400).json({ code: 'validation_failed', message: 'Invalid ref parameter' })
  }
  const projectRef = String(req.query.ref)
  if (req.method === 'GET') {
    const allowed = await guardProjectRoute(res, claims, {
      action: PermissionAction.READ,
      projectRef,
      resource: 'projects',
    })
    if (!allowed) return
    const registry = await getProjectEndpointRegistry(projectRef)
    if (!registry) {
      return res.status(409).json({
        code: 'endpoint_registry_unconfigured',
        message: new EndpointRegistryMissing(projectRef).message,
      })
    }
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json(registry)
  }
  if (req.method === 'PATCH') {
    const allowed = await guardProjectRoute(res, claims, {
      action: PermissionAction.UPDATE,
      projectRef,
      resource: 'projects',
    })
    if (!allowed) return
    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ code: 'validation_failed', message: parsed.error.message })
    }
    try {
      await requireProjectCapability(projectRef, 'project.connection.update')
      const registry = await updateProjectEndpointRegistry({
        projectRef,
        expectedRevision: parsed.data.expectedRevision,
        endpoints: parsed.data.endpoints,
        actor: claims?.sub ?? 'unknown',
        correlationId:
          (typeof req.headers['x-correlation-id'] === 'string' &&
            req.headers['x-correlation-id']) ||
          randomUUID(),
      })
      res.setHeader('Cache-Control', 'no-store')
      return res.status(200).json(registry)
    } catch (error) {
      if (error instanceof CapabilityUnavailable) {
        return res.status(409).json({
          code: 'capability_unavailable',
          message: error.message,
          blockers: error.blockers,
        })
      }
      if (error instanceof EndpointRevisionConflict) {
        return res
          .status(409)
          .json({ code: 'connection_revision_conflict', message: error.message })
      }
      throw error
    }
  }
  res.setHeader('Allow', ['GET', 'PATCH'])
  return res.status(405).json({ code: 'validation_failed', message: 'Method not allowed' })
}
