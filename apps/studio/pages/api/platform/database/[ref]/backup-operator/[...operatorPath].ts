import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { CapabilityUnavailable, requireProjectCapability } from '@/lib/api/self-platform/attachment'
import {
  BackupOperatorAPIError,
  requestBackupOperator,
  requestBackupOperatorEvents,
} from '@/lib/api/self-platform/backup-operator-client'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type OperatorRoute = {
  method: 'GET' | 'POST' | 'PUT'
  path: string
  destructive?: boolean
  eventOperationId?: string
}

function resolveRoute(method: string | undefined, segments: string[]): OperatorRoute | null {
  const joined = segments.join('/')
  if (method === 'GET' && joined === 'cluster') return { method: 'GET', path: '' }
  if (method === 'POST' && joined === 'discover') return { method: 'POST', path: '/discover' }
  if (method === 'GET' && joined === 'policy') return { method: 'GET', path: '/backup-policy' }
  if (method === 'PUT' && joined === 'policy') return { method: 'PUT', path: '/backup-policy' }
  if (method === 'GET' && joined === 'backups') return { method: 'GET', path: '/backups' }
  if (method === 'POST' && joined === 'backups') return { method: 'POST', path: '/backups' }
  if (method === 'GET' && joined === 'pitr') return { method: 'GET', path: '/pitr' }
  if (method === 'POST' && joined === 'pitr/enable') return { method: 'POST', path: '/pitr/enable' }
  if (method === 'POST' && joined === 'pitr/disable')
    return { method: 'POST', path: '/pitr/disable' }
  if (method === 'POST' && joined === 'restore-plans') {
    return { method: 'POST', path: '/restore-plans' }
  }
  const eventMatch = joined.match(/^jobs\/([a-zA-Z0-9_-]+)\/events$/)
  if (method === 'GET' && eventMatch) {
    return {
      method: 'GET',
      path: `/jobs/${eventMatch[1]}/events`,
      eventOperationId: eventMatch[1],
    }
  }
  const match = joined.match(
    /^(jobs|restore-plans)\/([a-zA-Z0-9_-]+)(?:\/(confirm|execute|rollback|retry|cancel))?$/
  )
  if (!match) return null
  const [, resource, id, action] = match
  if (method === 'GET' && resource === 'jobs' && action === undefined) {
    return { method: 'GET', path: `/jobs/${id}` }
  }
  if (method === 'GET' && resource === 'restore-plans' && action === undefined) {
    return { method: 'GET', path: `/restore-plans/${id}` }
  }
  if (method === 'POST' && resource === 'jobs' && action && ['retry', 'cancel'].includes(action)) {
    return { method: 'POST', path: `/jobs/${id}/${action}` }
  }
  if (method === 'POST' && action && ['confirm', 'execute', 'rollback'].includes(action)) {
    return { method: 'POST', path: `/${resource}/${id}/${action}`, destructive: true }
  }
  return null
}

const backupOperatorHandler = (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

export default backupOperatorHandler

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (!IS_SELF_PLATFORM) return res.status(404).json({ message: 'Not found' })
  if (STUDIO_DEPLOYMENT_PROFILE === 'fleet' && !STUDIO_CAPABILITIES.backupManagement) {
    return res.status(404).json({ message: 'Not found' })
  }
  const projectRef = String(req.query.ref)
  const segments = Array.isArray(req.query.operatorPath)
    ? req.query.operatorPath
    : [String(req.query.operatorPath)]
  const route = resolveRoute(req.method, segments)
  if (!route) return res.status(405).json({ message: 'Backup Operator operation is not allowed' })

  const isAllowed = await guardProjectRoute(res, claims, {
    action: route.method === 'GET' ? PermissionAction.READ : PermissionAction.UPDATE,
    projectRef,
  })
  if (!isAllowed) return
  if (route.destructive && claims?.aal !== 'aal2') {
    return res
      .status(403)
      .json({ code: 'AAL2_REQUIRED', message: 'A recent AAL2 session is required' })
  }

  try {
    if (STUDIO_DEPLOYMENT_PROFILE === 'fleet') {
      await requireProjectCapability(projectRef, 'management.agent.connect')
    }
    let correlationId: string | undefined
    const commonInit = {
      actor: claims?.sub ?? 'studio-api',
      aal: typeof claims?.aal === 'string' ? claims.aal : undefined,
      aalAuthenticatedAt:
        claims?.aal === 'aal2' && typeof claims.iat === 'number' ? claims.iat : undefined,
      correlationId:
        typeof req.headers['x-correlation-id'] === 'string'
          ? req.headers['x-correlation-id']
          : undefined,
      idempotencyKey:
        route.method !== 'GET' && typeof req.headers['idempotency-key'] === 'string'
          ? req.headers['idempotency-key']
          : undefined,
      onResponse: (metadata: { correlationId?: string }) => {
        correlationId = metadata.correlationId
      },
    }
    if (route.eventOperationId) {
      const cursorValue = Array.isArray(req.query.cursor) ? req.query.cursor[0] : req.query.cursor
      const cursor = cursorValue === undefined ? 0 : Number(cursorValue)
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        return res
          .status(400)
          .json({ code: 'INVALID_CURSOR', message: 'Cursor must be a non-negative integer' })
      }
      const events = await requestBackupOperatorEvents(
        projectRef,
        route.eventOperationId,
        cursor,
        commonInit
      )
      if (correlationId) res.setHeader('X-Correlation-ID', correlationId)
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Type', events.contentType)
      return res.status(200).send(events.body)
    }
    const data = await requestBackupOperator(projectRef, route.path, {
      method: route.method,
      body: route.method === 'GET' ? undefined : req.body,
      ...commonInit,
    })
    if (correlationId) res.setHeader('X-Correlation-ID', correlationId)
    return res.status(200).json(data)
  } catch (error) {
    if (error instanceof CapabilityUnavailable) {
      return res.status(409).json({
        code: 'capability_unavailable',
        message: error.message,
        blockers: error.blockers,
      })
    }
    if (error instanceof BackupOperatorAPIError) {
      if (error.metadata.correlationId) {
        res.setHeader('X-Correlation-ID', error.metadata.correlationId)
      }
      return res.status(error.status).json({
        code: error.code,
        message: error.message,
        correlation_id: error.metadata.correlationId,
        retryable: error.metadata.retryable,
        details: error.metadata.details,
      })
    }
    return res.status(503).json({ code: 'UNAVAILABLE', message: 'Backup Operator is unavailable' })
  }
}
