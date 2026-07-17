import { createHash } from 'node:crypto'
import { z } from 'zod'

import { executePlatformQuery } from './db'
import { encryptSecret } from './secrets'

export const functionSecretNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'Secret names must use environment variable syntax')

export const functionSecretInputSchema = z
  .object({
    name: functionSecretNameSchema,
    value: z.string().min(1).max(65_536),
  })
  .strict()

const functionSecretRowSchema = z.object({
  name: functionSecretNameSchema,
  value_digest: z.string().regex(/^[0-9a-f]{64}$/),
  updated_at: z.string().datetime({ offset: true }),
})

export type FunctionSecretMetadata = {
  name: string
  value: string
  updated_at: string
}

export async function listFunctionSecretMetadata(
  projectRef: string
): Promise<FunctionSecretMetadata[]> {
  if (!projectRef) throw new Error('projectRef is required')
  const result = await executePlatformQuery({
    query: `select name, value_digest, updated_at
      from platform.function_secrets where project_ref = $1 order by name`,
    parameters: [projectRef],
  })
  if (result.error) throw result.error
  return (result.data ?? []).map((value) => {
    const row = functionSecretRowSchema.parse(value)
    return { name: row.name, value: row.value_digest, updated_at: row.updated_at }
  })
}

export async function upsertFunctionSecrets(input: {
  projectRef: string
  secrets: Array<z.infer<typeof functionSecretInputSchema>>
  actor: string
  correlationId: string
}): Promise<void> {
  const secrets = z.array(functionSecretInputSchema).min(1).max(100).parse(input.secrets)
  if (!input.projectRef || !input.actor || !input.correlationId) {
    throw new Error('Complete secret mutation identity is required')
  }
  const uniqueNames = new Set(secrets.map((secret) => secret.name))
  if (uniqueNames.size !== secrets.length) throw new Error('Secret names must be unique')
  const encrypted = secrets.map((secret) => ({
    name: secret.name,
    ciphertext: encryptSecret(secret.value),
    digest: createHash('sha256').update(secret.value, 'utf8').digest('hex'),
  }))
  const result = await executePlatformQuery({
    query: `with input as (
        select * from jsonb_to_recordset($2::jsonb)
          as item(name text, ciphertext text, digest text)
      ), changed as (
        insert into platform.function_secrets as secret (
          project_ref, name, value_ciphertext, value_digest, updated_by
        )
        select $1, name, ciphertext, digest, $3 from input
        on conflict (project_ref, name) do update set
          value_ciphertext = excluded.value_ciphertext,
          value_digest = excluded.value_digest,
          version = secret.version + 1,
          updated_by = excluded.updated_by,
          updated_at = now()
        returning name
      )
      insert into platform.audit_events (
        actor, project_ref, action, correlation_id, payload
      ) select $3, $1, 'fleet.function.secret.upsert', $4,
        jsonb_build_object('names', coalesce(jsonb_agg(name order by name), '[]'::jsonb))
      from changed`,
    parameters: [input.projectRef, JSON.stringify(encrypted), input.actor, input.correlationId],
  })
  if (result.error) throw result.error
}

export async function deleteFunctionSecrets(input: {
  projectRef: string
  names: string[]
  actor: string
  correlationId: string
}): Promise<void> {
  const names = z.array(functionSecretNameSchema).min(1).max(100).parse(input.names)
  if (!input.projectRef || !input.actor || !input.correlationId) {
    throw new Error('Complete secret mutation identity is required')
  }
  if (new Set(names).size !== names.length) throw new Error('Secret names must be unique')
  const result = await executePlatformQuery({
    query: `with deleted as (
        delete from platform.function_secrets
        where project_ref = $1 and name = any($2::text[])
        returning name
      )
      insert into platform.audit_events (
        actor, project_ref, action, correlation_id, payload
      ) select $3, $1, 'fleet.function.secret.delete', $4,
        jsonb_build_object('names', coalesce(jsonb_agg(name order by name), '[]'::jsonb))
      from deleted`,
    parameters: [input.projectRef, names, input.actor, input.correlationId],
  })
  if (result.error) throw result.error
}
