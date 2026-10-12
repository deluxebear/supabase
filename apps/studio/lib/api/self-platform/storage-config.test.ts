import { describe, expect, it } from 'vitest'

import {
  MAX_FILE_SIZE_LIMIT,
  renderStorageEnv,
  storageAppliedFields,
  storageUpdateSchema,
  toStoredStorageOverrides,
} from './storage-config'

describe('toStoredStorageOverrides', () => {
  it('keeps only the settings Fleet can apply', () => {
    const body = storageUpdateSchema.parse({
      fileSizeLimit: 1048576,
      features: {
        imageTransformation: { enabled: false },
        s3Protocol: { enabled: false },
      },
    })
    expect(toStoredStorageOverrides(body)).toEqual({
      fileSizeLimit: 1048576,
      imageTransformationEnabled: false,
    })
  })

  it('stores nothing for a body without applicable settings', () => {
    expect(toStoredStorageOverrides(storageUpdateSchema.parse({ features: {} }))).toEqual({})
  })

  it('rejects limits outside the supported range', () => {
    expect(storageUpdateSchema.safeParse({ fileSizeLimit: -1 }).success).toBe(false)
    expect(storageUpdateSchema.safeParse({ fileSizeLimit: MAX_FILE_SIZE_LIMIT + 1 }).success).toBe(
      false
    )
  })
})

describe('renderStorageEnv', () => {
  it('renders stored overrides, including a disabled feature', () => {
    const stored = { fileSizeLimit: 1048576, imageTransformationEnabled: false }
    expect(renderStorageEnv(stored)).toEqual({
      FILE_SIZE_LIMIT: '1048576',
      ENABLE_IMAGE_TRANSFORMATION: 'false',
    })
    expect(storageAppliedFields(stored)).toEqual(['fileSizeLimit', 'imageTransformationEnabled'])
  })

  it('renders nothing for no overrides or a malformed document', () => {
    expect(renderStorageEnv({})).toEqual({})
    expect(renderStorageEnv({ fileSizeLimit: 'big' })).toEqual({})
  })
})
