import { describe, expect, it } from 'vitest'

import { formatFunctionBodyToFiles } from './EdgeFunctions.utils'

describe('formatFunctionBodyToFiles', () => {
  it('shows downloaded files when the API does not provide an entrypoint path', () => {
    const files = formatFunctionBodyToFiles({
      functionBody: {
        metadata: {},
        files: [
          {
            name: 'index.ts',
            content: 'Deno.serve(() => new Response("ok"))',
          },
        ],
      },
    })

    expect(files).toEqual([
      {
        id: 1,
        name: 'index.ts',
        content: 'Deno.serve(() => new Response("ok"))',
        state: 'unchanged',
      },
    ])
  })

  it('keeps downloaded file paths unchanged without entrypoint metadata', () => {
    const files = formatFunctionBodyToFiles({
      functionBody: {
        metadata: {},
        files: [
          { name: 'src/index.ts', content: 'export default 1' },
          { name: 'deno.json', content: '{}' },
        ],
      },
    })

    expect(files.map(({ name }) => name)).toEqual(['src/index.ts', 'deno.json'])
  })
})
