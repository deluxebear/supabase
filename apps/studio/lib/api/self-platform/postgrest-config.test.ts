import { describe, expect, it } from 'vitest'

import { toComposeOverrideYaml } from './auth-runtime'
import {
  postgrestAppliedFields,
  postgrestUpdateSchema,
  renderPostgrestEnv,
} from './postgrest-config'

describe('postgrestUpdateSchema', () => {
  it('normalizes schema lists', () => {
    const parsed = postgrestUpdateSchema.parse({
      db_schema: ' public , storage,,graphql_public ',
      db_extra_search_path: 'public, extensions',
    })
    expect(parsed).toEqual({
      db_schema: 'public,storage,graphql_public',
      db_extra_search_path: 'public,extensions',
    })
  })

  it('rejects injection through schema names and out-of-range numbers', () => {
    expect(postgrestUpdateSchema.safeParse({ db_schema: 'public,"; drop' }).success).toBe(false)
    expect(postgrestUpdateSchema.safeParse({ db_schema: '' }).success).toBe(false)
    expect(postgrestUpdateSchema.safeParse({ max_rows: 0 }).success).toBe(false)
    expect(postgrestUpdateSchema.safeParse({ max_rows: 1.5 }).success).toBe(false)
    expect(postgrestUpdateSchema.safeParse({ unknown_field: 1 }).success).toBe(false)
  })

  it('allows an empty extra search path and a null pool', () => {
    expect(
      postgrestUpdateSchema.safeParse({ db_extra_search_path: '', db_pool: null }).success
    ).toBe(true)
  })
})

describe('renderPostgrestEnv', () => {
  it('renders only the stored overrides', () => {
    expect(renderPostgrestEnv({})).toEqual({})
    expect(renderPostgrestEnv({ max_rows: 500, db_schema: 'public,api' })).toEqual({
      PGRST_DB_MAX_ROWS: '500',
      PGRST_DB_SCHEMAS: 'public,api',
    })
  })

  it('ignores a stored document that fails validation', () => {
    expect(renderPostgrestEnv({ max_rows: 'lots' })).toEqual({})
  })

  it('lists the applied fields and renders a Compose override', () => {
    const stored = { max_rows: 500, db_pool: 20 }
    expect(postgrestAppliedFields(stored)).toEqual(['db_pool', 'max_rows'])
    expect(toComposeOverrideYaml('rest', renderPostgrestEnv(stored), '# h')).toBe(
      '# h\nservices:\n  rest:\n    environment:\n      PGRST_DB_MAX_ROWS: "500"\n      PGRST_DB_POOL: "20"\n'
    )
  })
})
