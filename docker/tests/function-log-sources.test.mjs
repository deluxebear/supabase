import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('source bootstrap recovers a saved source after HTTP 500 and is idempotent', async () => {
  const sources = [{ name: 'function_edge_logs', token: '11111111-1111-1111-1111-111111111111' }, { name: 'unified_logs', token: '33333333-3333-3333-3333-333333333333' }]
  let creations = 0
  let initializations = 0
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/ingest-sources') return res.end(JSON.stringify(sources))
    if (req.url === '/api/sources') {
      creations++
      sources.push({ name: 'function_logs', token: '22222222-2222-2222-2222-222222222222' })
      res.statusCode = 500
      return res.end(JSON.stringify({ error: 'Serializer failed' }))
    }
    if (req.url === '/api/logs?source=22222222-2222-2222-2222-222222222222') {
      initializations++
      return res.end('{}')
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const directory = await mkdtemp(join(tmpdir(), 'function-log-sources-'))
  const template = join(directory, 'template.yml')
  const output = join(directory, 'vector.yml')
  await writeFile(
    template,
    'source_name=deno-subhosting-events\nsource_name=deno-relay-logs\nsource_name=unified.logs\n${LOGFLARE_PUBLIC_ACCESS_TOKEN}'
  )
  try {
    for (let run = 0; run < 2; run++) {
      await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['docker/volumes/logs/bootstrap-function-sources.mjs'],
          {
            env: {
              ...process.env,
              LOGFLARE_URL: `http://127.0.0.1:${server.address().port}`,
              LOGFLARE_PRIVATE_ACCESS_TOKEN: 'private-test',
              LOGFLARE_PUBLIC_ACCESS_TOKEN: 'public-test',
              VECTOR_TEMPLATE_PATH: template,
              VECTOR_OUTPUT_PATH: output,
            },
            stdio: 'pipe',
          }
        )
        child.on('error', reject)
        child.on('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`Bootstrap exited ${code}`))
        )
      })
    }
    assert.equal(creations, 1)
    assert.equal(initializations, 1)
    assert.equal(
      await readFile(output, 'utf8'),
      'source=22222222-2222-2222-2222-222222222222\nsource=11111111-1111-1111-1111-111111111111\nsource=33333333-3333-3333-3333-333333333333\n${LOGFLARE_PUBLIC_ACCESS_TOKEN}'
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
