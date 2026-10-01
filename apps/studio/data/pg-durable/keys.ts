export const pgDurableKeys = {
  all: (projectRef?: string) => ['projects', projectRef, 'pg-durable'] as const,
  configuration: (projectRef?: string, connectionString?: string | null) =>
    [...pgDurableKeys.all(projectRef), 'configuration', connectionString] as const,
  metrics: (projectRef?: string, connectionString?: string | null) =>
    [...pgDurableKeys.all(projectRef), 'metrics', connectionString] as const,
  instances: (
    projectRef?: string,
    status = 'all',
    label = '',
    cursor = '',
    connectionString?: string | null
  ) =>
    [
      ...pgDurableKeys.all(projectRef),
      'instances',
      status,
      label,
      cursor,
      connectionString,
    ] as const,
  instance: (projectRef?: string, instanceId?: string, connectionString?: string | null) =>
    [...pgDurableKeys.all(projectRef), 'instance', instanceId, connectionString] as const,
  explain: (projectRef?: string, input?: string | null, connectionString?: string | null) =>
    [...pgDurableKeys.all(projectRef), 'explain', input, connectionString] as const,
}
