import { waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useMfaListFactorsQuery } from '@/data/profile/mfa-list-factors-query'
import { auth } from '@/lib/gotrue'
import { customRenderHook } from '@/tests/lib/custom-render'

vi.mock('@/lib/gotrue', () => ({
  auth: { mfa: { listFactors: vi.fn() } },
}))

describe('useMfaListFactorsQuery', () => {
  beforeEach(() => {
    vi.mocked(auth.mfa.listFactors).mockResolvedValue({
      data: { all: [], totp: [], phone: [], recovery_code: [], webauthn: [] },
      error: null,
    })
  })

  it('does not request factors while the query is disabled', () => {
    customRenderHook(() => useMfaListFactorsQuery({ enabled: false }))
    expect(auth.mfa.listFactors).not.toHaveBeenCalled()
  })

  it('requests factors when the query is enabled', async () => {
    const hook = customRenderHook(() => useMfaListFactorsQuery({ enabled: true }))
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true))
    expect(auth.mfa.listFactors).toHaveBeenCalledOnce()
  })
})
