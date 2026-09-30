import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const baseUrl = process.env.LOGFLARE_URL ?? 'http://analytics:4000'
const headers = {
  'x-api-key': process.env.LOGFLARE_PRIVATE_ACCESS_TOKEN,
  'Content-Type': 'application/json',
}

async function listSources() {
  const response = await fetch(`${baseUrl}/api/ingest-sources`, { headers })
  if (!response.ok) throw new Error(`Cannot discover function log sources (${response.status})`)
  return response.json()
}

let sources = await listSources()
for (const name of ['function_edge_logs', 'function_logs']) {
  if (sources.some((source) => source.name === name)) continue
  const response = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name }),
  })
  // Logflare 1.50 can save a PG source and then fail its BigQuery response
  // serializer. Discover the saved source before retrying the creation.
  sources = await listSources()
  const source = sources.find((source) => source.name === name)
  if (!source) throw new Error(`Cannot create ${name} (${response.status})`)
  const initialized = await fetch(`${baseUrl}/api/logs?source=${source.token}`, {
    method: 'POST',
    headers: { ...headers, 'x-api-key': process.env.LOGFLARE_PUBLIC_ACCESS_TOKEN },
    body: JSON.stringify([
      {
        event_message: 'Function metrics source initialized',
        metadata: { project_ref: 'default' },
      },
    ]),
  })
  if (!initialized.ok) throw new Error(`Cannot initialize ${name} (${initialized.status})`)
}

let config = await readFile(process.env.VECTOR_TEMPLATE_PATH ?? '/etc/vector/template.yml', 'utf8')
for (const [legacyName, name] of [
  ['deno-subhosting-events', 'function_logs'],
  ['deno-relay-logs', 'function_edge_logs'],
]) {
  const source = sources.find((source) => source.name === name)
  if (!source || !/^[0-9a-f-]{36}$/.test(source.token)) throw new Error(`Invalid ${name} source ID`)
  config = config.replace(`source_name=${legacyName}`, `source=${source.token}`)
}
const output = process.env.VECTOR_OUTPUT_PATH ?? '/etc/vector/generated/vector.yml'
await mkdir(dirname(output), { recursive: true })
await writeFile(output, config)
console.log('Function log sources and Vector configuration are ready')
