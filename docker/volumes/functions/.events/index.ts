// EventManager reports user-worker lifecycle events independently of requests.
const events = new globalThis.EventManager()

for await (const data of events) {
  if (!data?.metadata?.execution_id || !data.metadata.service_path) continue
  const path = data.metadata.service_path
  const slug = path.includes('/.fleet-artifacts/')
    ? path.split('/.fleet-artifacts/')[1].split('/')[0]
    : path.split('/').filter(Boolean).pop()
  if (!slug || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(slug) || slug === 'main') continue

  const event = data.event ?? {}
  let level = 'log'
  if (data.event_type === 'Log') level = String(event.level ?? 'info').toLowerCase()
  if (data.event_type === 'UncaughtException') level = 'error'
  let message = data.event_type.toLowerCase()
  if (data.event_type === 'Log') message = String(event.msg ?? '')
  if (data.event_type === 'Boot') message = `booted (time: ${event.boot_time}ms)`
  if (data.event_type === 'UncaughtException')
    message = String(event.exception ?? 'Uncaught exception')
  const metadata = {
    ...event,
    function_id: `${Deno.env.get('FUNCTIONS_PROJECT_REF') ?? 'default'}:${slug}`,
    execution_id: data.metadata.execution_id,
    event_type: data.event_type,
    level,
  }
  // PG-backed Logflare cannot query arbitrary metadata. Keep a queryable
  // envelope alongside the original structured fields for log details.
  const shutdown = data.event_type === 'Shutdown' ? event : {}
  const fields = [
    data.event_type,
    slug,
    metadata.execution_id,
    level,
    shutdown.cpu_time_used ?? '',
    shutdown.memory_used?.total ?? '',
    shutdown.memory_used?.heap ?? '',
    shutdown.memory_used?.external ?? '',
    JSON.stringify({ ...metadata, event_message: message }),
  ]
  console.log(
    JSON.stringify({
      log_type: 'FunctionEvent',
      timestamp: data.timestamp,
      event_message: fields.join(' | '),
      metadata,
    })
  )
}
