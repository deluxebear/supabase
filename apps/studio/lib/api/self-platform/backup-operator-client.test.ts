import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { requestBackupOperator } from './backup-operator-client'
import { resolveProjectConnection } from './resolve-connection'
import { mswServer } from '@/tests/lib/msw'

vi.mock('./resolve-connection', () => ({ resolveProjectConnection: vi.fn() }))

beforeEach(() => {
  process.env.BACKUP_OPERATOR_URL = 'http://operator.test'
  process.env.BACKUP_OPERATOR_SERVICE_ASSERTION_KEY = '01234567890123456789012345678901'
  vi.mocked(resolveProjectConnection).mockResolvedValue({
    row: { stack_meta: { backupOperatorClusterId: 'cluster-a' } },
  } as never)
})

afterEach(() => {
  delete process.env.BACKUP_OPERATOR_URL
  delete process.env.BACKUP_OPERATOR_SERVICE_ASSERTION_KEY
})

describe('Backup Operator self-platform client', () => {
  it('maps project ref to cluster and mints a short-lived assertion per request', async () => {
    const authorizations: string[] = []
    let correlationId = ''
    let auditContext = ''
    mswServer.use(
      http.get('http://operator.test/v1/clusters/cluster-a/backup-policy', ({ request }) => {
        authorizations.push(request.headers.get('authorization') ?? '')
        correlationId = request.headers.get('x-correlation-id') ?? ''
        auditContext = request.headers.get('x-audit-context') ?? ''
        return HttpResponse.json({ enabled: true })
      })
    )
    await expect(requestBackupOperator('project-a', '/backup-policy')).resolves.toEqual({
      enabled: true,
    })
    await requestBackupOperator('project-a', '/backup-policy')
    expect(authorizations).toHaveLength(2)
    expect(authorizations[0]).not.toBe(authorizations[1])
    const token = authorizations[0].replace('Bearer ', '')
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    expect(claims).toMatchObject({
      iss: 'supabase-studio',
      aud: 'backup-operator',
      sub: 'studio-api',
      projects: ['cluster-a'],
    })
    expect(claims.exp - claims.iat).toBe(60)
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.parse(auditContext)).toEqual({
      actor: 'studio-api',
      aal: 'unknown',
      source: 'studio',
    })
  })

  it('maps upstream authentication failures to a typed error', async () => {
    mswServer.use(
      http.get('http://operator.test/v1/clusters/cluster-a/backup-policy', () =>
        HttpResponse.json(
          {
            code: 'assertion_expired',
            message: 'Invalid service assertion',
            correlation_id: 'operator-correlation',
            retryable: false,
            details: { issuer: 'unexpected' },
          },
          { status: 401 }
        )
      )
    )
    await expect(requestBackupOperator('project-a', '/backup-policy')).rejects.toMatchObject({
      code: 'assertion_expired',
      status: 401,
      message: 'Invalid service assertion',
      metadata: {
        correlationId: 'operator-correlation',
        retryable: false,
        details: { issuer: 'unexpected' },
      },
    })
  })

  it('adds a stable idempotency key to mutations', async () => {
    const keys: string[] = []
    mswServer.use(
      http.post('http://operator.test/v1/clusters/cluster-a/restore-plans', ({ request }) => {
        keys.push(request.headers.get('idempotency-key') ?? '')
        return HttpResponse.json({ id: 'plan-a' })
      })
    )
    const mutation = () =>
      requestBackupOperator('project-a', '/restore-plans', {
        method: 'POST',
        body: { recoveryTarget: '2026-07-13T00:00:00Z' },
      })
    await mutation()
    await mutation()
    expect(keys).toHaveLength(2)
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(keys[1]).toBe(keys[0])
  })

  it('signs trusted AAL2 context while keeping the confirmation body free of identity claims', async () => {
    let authorization = ''
    let requestBody: unknown
    mswServer.use(
      http.post(
        'http://operator.test/v1/clusters/cluster-a/restore-plans/plan-a/confirm',
        async ({ request }) => {
          authorization = request.headers.get('authorization') ?? ''
          requestBody = await request.json()
          return HttpResponse.json({ id: 'plan-a', state: 'confirmed' })
        }
      )
    )

    await requestBackupOperator('project-a', '/restore-plans/plan-a/confirm', {
      method: 'POST',
      body: { planHash: 'hash-a' },
      actor: 'owner',
      aal: 'aal2',
      aalAuthenticatedAt: 1_700_000_000,
    })

    const token = authorization.replace('Bearer ', '')
    const signedClaims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    expect(signedClaims).toMatchObject({
      sub: 'owner',
      aal: 'aal2',
      aal_authenticated_at: 1_700_000_000,
    })
    expect(requestBody).toEqual({ planHash: 'hash-a' })
  })

  it('fails closed when the server-side assertion is not configured', async () => {
    delete process.env.BACKUP_OPERATOR_SERVICE_ASSERTION_KEY
    await expect(requestBackupOperator('project-a', '/backup-policy')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      status: 503,
    })
  })
})
