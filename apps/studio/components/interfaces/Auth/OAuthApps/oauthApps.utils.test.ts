import { describe, expect, it } from 'vitest'

import {
  getOAuthAppOptionLabel,
  OAUTH_APP_CLIENT_TYPE_OPTIONS,
  OAUTH_APP_REGISTRATION_TYPE_OPTIONS,
} from './oauthApps.utils'

describe('getOAuthAppOptionLabel', () => {
  it('maps raw API values to their option labels', () => {
    expect(getOAuthAppOptionLabel(OAUTH_APP_CLIENT_TYPE_OPTIONS, 'confidential')).toBe(
      'Confidential'
    )
    expect(getOAuthAppOptionLabel(OAUTH_APP_REGISTRATION_TYPE_OPTIONS, 'dynamic')).toBe('Dynamic')
  })

  it('returns unknown values unchanged', () => {
    expect(getOAuthAppOptionLabel(OAUTH_APP_CLIENT_TYPE_OPTIONS, 'other')).toBe('other')
  })
})
