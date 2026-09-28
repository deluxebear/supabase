export const secretsKeys = {
  list: (projectRef: string | undefined) =>
    ['projects', projectRef, 'edge_functions_secrets'] as const,
  // Under `list` so every secret change also refreshes the apply status.
  applyStatus: (projectRef: string | undefined) =>
    ['projects', projectRef, 'edge_functions_secrets', 'apply'] as const,
}
