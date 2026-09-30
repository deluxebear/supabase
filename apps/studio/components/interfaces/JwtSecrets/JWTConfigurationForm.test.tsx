import { fireEvent, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { JWTConfigurationForm } from './JWTConfigurationForm'
import { API_URL } from '@/lib/constants'
import { customRender } from '@/tests/lib/custom-render'
import { mswServer } from '@/tests/lib/msw'

const { permissions } = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
  return { permissions: { can: true, isSuccess: true } }
})
vi.mock('@/hooks/misc/useCheckPermissions', () => ({ useAsyncCheckPermissions: () => permissions }))
const status = {
  availability: { isAvailable: true },
  state: 'pending',
  expectedGeneration: 0,
  isOwnedByFleet: true,
  observedAt: new Date().toISOString(),
  recipientPublicKey: 'public-key',
  services: ['auth', 'rest'],
  operation: null,
}
const endpoint = `${API_URL}/platform/projects/:ref/config/jwt`
beforeEach(() => {
  permissions.can = true
  mswServer.use(http.get(endpoint, () => HttpResponse.json(status)))
})

describe('JWTConfigurationForm', () => {
  it('shows verified automatic synchronization and an explicit invalidation warning', async () => {
    customRender(<JWTConfigurationForm projectRef="project-d" />)
    expect(await screen.findByText('Automatic JWT synchronization')).toBeInTheDocument()
    expect(
      screen.getByText('Changing the JWT secret invalidates existing tokens')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply JWT configuration' })).toBeDisabled()
  })
  it('disables configuration without infrastructure permission', async () => {
    permissions.can = false
    customRender(<JWTConfigurationForm projectRef="project-d" />)
    expect(await screen.findByLabelText('New HS256 JWT secret')).toBeDisabled()
  })
  it('does not submit until token invalidation is confirmed', async () => {
    const request = vi.fn()
    mswServer.use(
      http.post(endpoint, () => {
        request()
        return HttpResponse.json({ operation: { id: 'op' } })
      })
    )
    customRender(<JWTConfigurationForm projectRef="project-d" />)
    fireEvent.change(await screen.findByLabelText('New HS256 JWT secret'), {
      target: { value: 's'.repeat(32) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply JWT configuration' }))
    expect(
      await screen.findByText('Confirm that existing tokens will stop working')
    ).toBeInTheDocument()
    expect(request).not.toHaveBeenCalled()
  })
  it('submits the expected generation and explicit confirmation with an idempotency key', async () => {
    const request = vi.fn()
    mswServer.use(
      http.post(endpoint, async ({ request: incoming }) => {
        request(await incoming.json(), incoming.headers.get('Idempotency-Key'))
        return HttpResponse.json({ operation: { id: 'op' } }, { status: 202 })
      })
    )
    customRender(<JWTConfigurationForm projectRef="project-d" />)
    fireEvent.change(await screen.findByLabelText('New HS256 JWT secret'), {
      target: { value: 's'.repeat(32) },
    })
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'I understand that existing tokens and legacy API keys will stop working',
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Apply JWT configuration' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          secret: 's'.repeat(32),
          expectedGeneration: 0,
          confirmTokenInvalidation: true,
        }),
        expect.any(String)
      )
    )
  })
})
