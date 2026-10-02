import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// `crypto.randomUUID` only exists in secure contexts (HTTPS or localhost). Self-hosted
// Studio is commonly opened over plain HTTP on a LAN address, where calling it throws
// "crypto.randomUUID is not a function". Browser code must use `uuidv4` from
// `@/lib/helpers` (backed by `crypto.getRandomValues`, available in all contexts).
const STUDIO_ROOT = join(__dirname, '..')
const BROWSER_DIRS = ['components', 'data', 'hooks', 'state', 'pages', 'lib']
// Server-only code runs in Node, where `node:crypto` is always available.
const SERVER_ONLY = [join('lib', 'api'), join('pages', 'api')]

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return collectSourceFiles(path)
    return /\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry) ? [path] : []
  })
}

describe('browser code in insecure contexts', () => {
  it('never calls crypto.randomUUID()', () => {
    const offenders = BROWSER_DIRS.flatMap((dir) => collectSourceFiles(join(STUDIO_ROOT, dir)))
      .filter(
        (file) => !SERVER_ONLY.some((prefix) => relative(STUDIO_ROOT, file).startsWith(prefix))
      )
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((line, index) => ({ line: line.trim(), index }))
          .filter(({ line }) => !line.startsWith('//') && line.includes('crypto.randomUUID()'))
          .map(({ index }) => `${relative(STUDIO_ROOT, file)}:${index + 1}`)
      )

    expect(offenders).toEqual([])
  })
})
