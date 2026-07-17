import { describe, expect, it } from 'vitest'

import { createInitialFeatureFlagStore } from './feature-flags'

describe('createInitialFeatureFlagStore', () => {
  it.each([
    { enabled: false, expectedHasLoaded: true },
    { enabled: { cc: false, ph: false }, expectedHasLoaded: true },
    { enabled: true, expectedHasLoaded: false },
    { enabled: { cc: true, ph: false }, expectedHasLoaded: false },
    { enabled: { cc: false, ph: true }, expectedHasLoaded: false },
    { enabled: { cc: true, ph: true }, expectedHasLoaded: false },
  ])('sets hasLoaded to $expectedHasLoaded when enabled is $enabled', (testCase) => {
    expect(createInitialFeatureFlagStore('https://api.example.com', testCase.enabled)).toEqual({
      API_URL: 'https://api.example.com',
      configcat: {},
      posthog: {},
      hasLoaded: testCase.expectedHasLoaded,
    })
  })
})
