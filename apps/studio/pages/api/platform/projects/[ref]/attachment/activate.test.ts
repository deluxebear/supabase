import { describe, expect, it, vi } from 'vitest'

import { handler } from './activate'
import {
  activateStagedAttachment,
  AttachmentActivationBlocked,
} from '@/lib/api/self-platform/attachment'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/attachment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/self-platform/attachment')>()),
  activateStagedAttachment: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))

function response() {
  return {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(value: unknown) {
      this.payload = value
      return this
    },
    setHeader: vi.fn(),
  }
}

describe('POST project attachment activation', () => {
  it('keeps activation behind project UPDATE permission', async () => {
    vi.mocked(guardProjectRoute).mockResolvedValue(false)
    const res = response()
    await handler(
      { method: 'POST', query: { ref: 'project-a' }, headers: {} } as never,
      res as never,
      { sub: 'viewer-a' } as never
    )
    expect(activateStagedAttachment).not.toHaveBeenCalled()
  })

  it('returns stable blockers while Agent identity proof is incomplete', async () => {
    vi.mocked(guardProjectRoute).mockResolvedValue(true)
    vi.mocked(activateStagedAttachment).mockRejectedValue(
      new AttachmentActivationBlocked([
        { code: 'agent_not_online', message: 'Enroll the Agent first.' },
      ])
    )
    const res = response()
    await handler(
      { method: 'POST', query: { ref: 'project-a' }, headers: {} } as never,
      res as never,
      { sub: 'owner-a' } as never
    )
    expect(res.statusCode).toBe(409)
    expect(res.payload).toMatchObject({
      code: 'attachment_activation_blocked',
      blockers: [{ code: 'agent_not_online' }],
    })
  })

  it('activates a ready staged project', async () => {
    vi.mocked(guardProjectRoute).mockResolvedValue(true)
    vi.mocked(activateStagedAttachment).mockResolvedValue({
      projectRef: 'project-a',
      connectionRevision: 1,
      attachmentState: 'active',
    })
    const res = response()
    await handler(
      { method: 'POST', query: { ref: 'project-a' }, headers: {} } as never,
      res as never,
      { sub: 'owner-a' } as never
    )
    expect(res.statusCode).toBe(200)
    expect(res.payload).toMatchObject({ attachmentState: 'active' })
  })
})
