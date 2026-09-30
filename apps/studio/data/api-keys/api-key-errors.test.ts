import { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { beforeEach, expect, it, vi } from 'vitest'

import {
  APIKeyAAL2RequiredError,
  handleAPIKeyMutationError,
  showAPIKeyMfaAction,
} from './api-key-errors'
import { getMfaListFactors } from '@/data/profile/mfa-list-factors-query'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/data/profile/mfa-list-factors-query', () => ({ getMfaListFactors: vi.fn() }))
beforeEach(() => vi.clearAllMocks())
it.each(['aal2_required', 403])(
  'preserves the MFA requirement from the API response: %s',
  (code) => {
    expect(() =>
      handleAPIKeyMutationError({
        code,
        message: 'A recent AAL2 session is required.',
      })
    ).toThrow(APIKeyAAL2RequiredError)
  }
)
it.each([true, false])(
  'offers a verification or setup action based on enrolled factors: %s',
  async (enrolled) => {
    vi.mocked(getMfaListFactors).mockResolvedValue({
      totp: enrolled ? [{ id: 'factor' }] : [],
      all: [],
      phone: [],
    } as never)
    expect(
      await showAPIKeyMfaAction(new APIKeyAAL2RequiredError('Verify identity'), new QueryClient())
    ).toBe(true)
    expect(toast.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        action: expect.objectContaining({
          label: expect.any(String),
          onClick: expect.any(Function),
        }),
      })
    )
  }
)
it('keeps unrelated failures in the existing error path', async () => {
  expect(await showAPIKeyMfaAction(new Error('Gateway failed'), new QueryClient())).toBe(false)
  expect(toast.error).not.toHaveBeenCalled()
})
