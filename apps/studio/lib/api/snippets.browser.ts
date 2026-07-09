import { IS_PLATFORM } from 'common'
import { compact } from 'lodash'
import { v4 as uuidv4 } from 'uuid'

import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

/**
 * Generates a UUID v4. When snippets are stored on the filesystem — plain
 * self-hosted OR self-hosted platform — it generates a DETERMINISTIC UUID from
 * the inputs so the id matches the one the file-based store derives from
 * [folder, `${name}.sql`] (see snippets.utils.ts). Cloud platform is DB-backed
 * and uses a random UUID.
 *
 * [self-platform] IS_PLATFORM is true here too, but snippets still live as .sql
 * files, so it must mint deterministic ids like plain self-hosted — otherwise the
 * content GET by a random id 404s and the SQL editor bounces to /new.
 */
export const generateUuid = (inputs: (string | undefined | null)[] = []) => {
  const cleaned = compact(inputs)
  const usesFilesystemStorage = !IS_PLATFORM || IS_SELF_PLATFORM
  if (!usesFilesystemStorage || cleaned.length === 0) return uuidv4()
  return generateDeterministicUuid(cleaned)
}

/**
 * Generates a deterministic UUID v4 from a string input
 * @param inputs - The array of strings to generate a UUID from
 * @returns A deterministic UUID v4 string
 */
export function generateDeterministicUuid(inputs: (string | undefined | null)[]): string {
  const simpleHash = (str: string): number => {
    let hash = 0
    if (str.length === 0) return hash
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash = hash & hash // Convert to 32-bit integer
    }
    return Math.abs(hash)
  }

  const input = compact(inputs).join('_')

  // Create a deterministic random number generator using the hash as seed
  let seed = simpleHash(input)
  const rng = () => {
    const bytes = new Uint8Array(16)
    for (let i = 0; i < 16; i++) {
      // Simple LCG (Linear Congruential Generator) for deterministic randomness
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      bytes[i] = (seed >>> 16) & 0xff
    }
    return bytes
  }

  // Generate UUID v4 using the deterministic RNG
  return uuidv4({ rng })
}
