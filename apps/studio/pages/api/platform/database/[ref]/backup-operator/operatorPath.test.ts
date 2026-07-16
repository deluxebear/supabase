import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './[...operatorPath]'
import {
  BackupOperatorAPIError,
  requestBackupOperator,
  requestBackupOperatorEvents,
} from '@/lib/api/self-platform/backup-operator-client'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.mock('@/lib/constants/self-platform', () => ({ IS_SELF_PLATFORM: true }))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/backup-operator-client', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/lib/api/self-platform/backup-operator-client')>()
  return {
    ...original,
    requestBackupOperator: vi.fn(),
    requestBackupOperatorEvents: vi.fn(),
  }
})

function responseRecorder() {
  const response = {} as NextApiResponse & { statusCode?: number; body?: unknown }
  response.status = vi.fn((status: number) => {
    response.statusCode = status
    return response
  }) as never
  response.json = vi.fn((body: unknown) => {
    response.body = body
    return response
  }) as never
  response.setHeader = vi.fn(() => response) as never
  response.send = vi.fn((body: unknown) => {
    response.body = body
    return response
  }) as never
  return response
}

function request(method: string, operatorPath: string[], body?: unknown) {
  return {
    method,
    query: { ref: 'project-a', operatorPath },
    body,
    headers: {},
  } as unknown as NextApiRequest
}

function claims(aal: 'aal1' | 'aal2' = 'aal1') {
  return { sub: 'owner', aal, iat: 1_700_000_000 } as JwtPayload
}

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true)
  vi.mocked(requestBackupOperator).mockReset().mockResolvedValue({ ok: true })
  vi.mocked(requestBackupOperatorEvents).mockReset().mockResolvedValue({
    body: 'id: 1\nevent: state\ndata: {}\n\n',
    contentType: 'text/event-stream',
  })
})

describe('self-platform Backup Operator proxy', () => {
  it('maps project policy reads through the fixed route allowlist', async () => {
    const response = responseRecorder()
    await handler(request('GET', ['policy']), response, claims())
    expect(requestBackupOperator).toHaveBeenCalledWith(
      'project-a',
      '/backup-policy',
      expect.objectContaining({ method: 'GET', body: undefined, actor: 'owner', aal: 'aal1' })
    )
    expect(response.statusCode).toBe(200)
  })

  it('uses infrastructure authorization for policy writes', async () => {
    const response = responseRecorder()
    await handler(request('PUT', ['policy'], { enabled: true }), response, claims())
    expect(guardProjectRoute).toHaveBeenCalledWith(
      response,
      expect.anything(),
      expect.objectContaining({
        action: 'infra:Execute',
        projectRef: 'project-a',
        resource: 'back_ups',
      })
    )
  })

  it('uses the restore preparation resource before creating an impact plan', async () => {
    const response = responseRecorder()
    await handler(
      request('POST', ['restore-plans'], { recoveryTarget: '2026-07-16T00:00:00Z' }),
      response,
      claims()
    )
    expect(guardProjectRoute).toHaveBeenCalledWith(
      response,
      expect.anything(),
      expect.objectContaining({
        action: 'infra:Execute',
        projectRef: 'project-a',
        resource: 'queue_job.restore.prepare',
      })
    )
  })

  it('checks restore execution permission before enforcing AAL2 or contacting the Operator', async () => {
    vi.mocked(guardProjectRoute).mockResolvedValue(false)
    const response = responseRecorder()
    await handler(request('POST', ['restore-plans', 'plan-1', 'execute']), response, claims('aal2'))

    expect(guardProjectRoute).toHaveBeenCalledWith(
      response,
      expect.anything(),
      expect.objectContaining({
        action: 'infra:Execute',
        resource: 'queue_job.restore.prepare',
        projectRef: 'project-a',
      })
    )
    expect(requestBackupOperator).not.toHaveBeenCalled()
  })

  it('forwards a caller-provided idempotency key for manual backups', async () => {
    const response = responseRecorder()
    const req = request('POST', ['backups'], { type: 'full' })
    req.headers['idempotency-key'] = 'manual-backup-click-a'

    await handler(req, response, claims())

    expect(requestBackupOperator).toHaveBeenCalledWith(
      'project-a',
      '/backups',
      expect.objectContaining({ idempotencyKey: 'manual-backup-click-a' })
    )
  })

  it.each([
    ['GET', ['cluster'], ''],
    ['POST', ['discover'], '/discover'],
    ['GET', ['pitr'], '/pitr'],
    ['POST', ['pitr', 'enable'], '/pitr/enable'],
    ['POST', ['backups'], '/backups'],
    ['GET', ['restore-plans', 'plan-1'], '/restore-plans/plan-1'],
    ['POST', ['jobs', 'job-1', 'retry'], '/jobs/job-1/retry'],
  ])('maps %s management route %s to the Operator', async (method, path, expected) => {
    const response = responseRecorder()
    await handler(request(method, path), response, claims())
    expect(requestBackupOperator).toHaveBeenCalledWith(
      'project-a',
      expected,
      expect.objectContaining({ method })
    )
  })

  it('requires AAL2 for confirmation without contacting the Operator', async () => {
    const response = responseRecorder()
    await handler(request('POST', ['restore-plans', 'plan-1', 'confirm']), response, claims())
    expect(response.statusCode).toBe(403)
    expect(requestBackupOperator).not.toHaveBeenCalled()
  })

  it('passes the verified AAL2 authentication time into the signed service assertion', async () => {
    const response = responseRecorder()
    await handler(
      request('POST', ['restore-plans', 'plan-1', 'confirm'], { planHash: 'hash-a' }),
      response,
      claims('aal2')
    )

    expect(requestBackupOperator).toHaveBeenCalledWith(
      'project-a',
      '/restore-plans/plan-1/confirm',
      expect.objectContaining({
        method: 'POST',
        body: { planHash: 'hash-a' },
        actor: 'owner',
        aal: 'aal2',
        aalAuthenticatedAt: 1_700_000_000,
      })
    )
  })

  it('allows non-destructive plan creation without AAL2', async () => {
    const response = responseRecorder()
    await handler(request('POST', ['restore-plans'], { recoveryTarget: 'now' }), response, claims())
    expect(requestBackupOperator).toHaveBeenCalledWith(
      'project-a',
      '/restore-plans',
      expect.objectContaining({
        method: 'POST',
        body: { recoveryTarget: 'now' },
        actor: 'owner',
        aal: 'aal1',
      })
    )
  })

  it('proxies bounded SSE replay pages with the requested cursor', async () => {
    const response = responseRecorder()
    const req = request('GET', ['jobs', 'job-1', 'events'])
    req.query.cursor = '7'
    await handler(req, response, claims())

    expect(requestBackupOperatorEvents).toHaveBeenCalledWith(
      'project-a',
      'job-1',
      7,
      expect.objectContaining({ actor: 'owner', aal: 'aal1' })
    )
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('id: 1')
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })

  it('maps typed Operator errors and rejects paths outside the allowlist', async () => {
    vi.mocked(requestBackupOperator).mockRejectedValueOnce(
      new BackupOperatorAPIError('CONFLICT', 'Plan changed', 409)
    )
    const conflict = responseRecorder()
    await handler(request('POST', ['restore-plans', 'plan-1', 'execute']), conflict, claims('aal2'))
    expect(conflict.statusCode).toBe(409)
    expect(conflict.body).toEqual({
      code: 'CONFLICT',
      message: 'Plan changed',
      correlation_id: undefined,
      retryable: undefined,
      details: undefined,
    })

    const rejected = responseRecorder()
    await handler(request('POST', ['shell']), rejected, claims('aal2'))
    expect(rejected.statusCode).toBe(405)
  })
})
