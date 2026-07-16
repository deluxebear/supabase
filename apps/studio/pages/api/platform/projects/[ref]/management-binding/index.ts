import { randomUUID } from 'node:crypto'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { CapabilityUnavailable, requireProjectCapability } from '@/lib/api/self-platform/attachment'
import {
  bindProjectManagementTarget,
  getProjectManagementBinding,
  managementBindingInputSchema,
  ManagementTrustConflict,
  ManagementTrustDownstreamError,
  revokeProjectManagementBinding,
  syncProjectManagementBinding,
} from '@/lib/api/self-platform/management-trust'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'

function isAvailable() {
  return STUDIO_DEPLOYMENT_PROFILE === 'fleet' && STUDIO_CAPABILITIES.managementTrust
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
  const action = req.method === 'GET' ? PermissionAction.READ : PermissionAction.UPDATE
  const allowed = await guardProjectRoute(res, claims, { action, projectRef, resource: 'projects' })
  if (!allowed) return

  try {
    if (req.method === 'GET') {
      await requireProjectCapability(projectRef, 'project.status.read')
      const binding = await getProjectManagementBinding(projectRef)
      return res.status(200).json({
        // Fleet Control creates its side of the binding when the first
        // enrollment token is issued. Until then the durable platform record
        // is the authoritative pending state; attempting a downstream sync
        // here would return 404 and deadlock the wizard before it can issue
        // that token.
        binding:
          binding && binding.state !== 'pending'
            ? await syncProjectManagementBinding({
                projectRef,
                actor: claims?.sub ?? 'unknown',
                correlationId:
                  (typeof req.headers['x-correlation-id'] === 'string' &&
                    req.headers['x-correlation-id']) ||
                  randomUUID(),
              })
            : binding,
      })
    }
    if (req.method === 'PUT') {
      await requireProjectCapability(projectRef, 'management.target.bind')
      const parsed = managementBindingInputSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({
          code: 'validation_failed',
          message: 'Management binding input is invalid',
          details: parsed.error.flatten(),
        })
      }
      const binding = await bindProjectManagementTarget({
        projectRef,
        binding: parsed.data,
        actor: claims?.sub ?? 'unknown',
        correlationId:
          (typeof req.headers['x-correlation-id'] === 'string' &&
            req.headers['x-correlation-id']) ||
          randomUUID(),
      })
      return res.status(201).json({ binding })
    }
    if (req.method === 'DELETE') {
      await requireProjectCapability(projectRef, 'management.target.bind')
      return res.status(200).json(
        await revokeProjectManagementBinding({
          projectRef,
          actor: claims?.sub ?? 'unknown',
          correlationId:
            (typeof req.headers['x-correlation-id'] === 'string' &&
              req.headers['x-correlation-id']) ||
            randomUUID(),
        })
      )
    }
  } catch (error) {
    if (error instanceof CapabilityUnavailable) {
      return res.status(409).json({
        code: 'capability_unavailable',
        message: error.message,
        blockers: error.blockers,
      })
    }
    if (error instanceof ManagementTrustConflict) {
      return res.status(409).json({ code: error.code, message: error.message })
    }
    if (error instanceof ManagementTrustDownstreamError) {
      return res
        .status(503)
        .json({ code: error.code, message: error.message, details: error.details })
    }
    throw error
  }
  res.setHeader('Allow', ['GET', 'PUT', 'DELETE'])
  return res.status(405).json({ code: 'validation_failed', message: 'Method not allowed' })
}
