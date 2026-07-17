import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

import { requireProjectCapability } from './attachment'
import { executePlatformQuery } from './db'
import {
  getProjectManagementBinding,
  ManagementTrustConflict,
  requestManagementDomain,
} from './management-trust'
import { listProjectOwnershipPolicies } from './ownership-policy'

const MAX_ARTIFACT_BYTES = 20 << 20
const MAX_FILE_BYTES = 4 << 20
const MAX_FILES = 512

const safePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Artifact paths must stay inside the function bundle'
  )

export const functionSlugSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/)

const sourceFileSchema = z
  .object({
    name: safePathSchema,
    content: z.string().max(MAX_FILE_BYTES),
  })
  .strict()
  .refine((value) => Buffer.byteLength(value.content, 'utf8') <= MAX_FILE_BYTES, {
    message: `Function source files must not exceed ${MAX_FILE_BYTES} bytes`,
    path: ['content'],
  })

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/)

const strictBase64Schema = z.string().refine((value) => {
  try {
    return value.length % 4 === 0 && Buffer.from(value, 'base64').toString('base64') === value
  } catch {
    return false
  }
}, 'Function artifact content must use canonical base64')

export const functionDeploymentInputSchema = z
  .object({
    slug: functionSlugSchema,
    expectedGeneration: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(1).max(255),
    metadata: z
      .object({
        entrypointPath: safePathSchema,
        importMapPath: safePathSchema.optional(),
        staticPatterns: z.array(safePathSchema).max(64).default([]),
        verifyJwt: z.boolean().default(true),
      })
      .strict(),
    files: z.array(sourceFileSchema).min(1).max(MAX_FILES),
  })
  .strict()

export const functionDeleteInputSchema = z
  .object({
    slug: functionSlugSchema,
    expectedGeneration: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(1).max(255),
  })
  .strict()

const bundleSchema = z
  .object({
    schema: z.literal('supabase.fleet.functions.bundle.v1'),
    files: z.array(
      z
        .object({
          path: safePathSchema,
          contentBase64: strictBase64Schema,
          mode: z.literal(384),
        })
        .strict()
    ),
  })
  .strict()

export function buildFunctionArtifact(value: z.infer<typeof functionDeploymentInputSchema>) {
  const input = functionDeploymentInputSchema.parse(value)
  const names = new Set<string>()
  for (const file of input.files) {
    if (names.has(file.name)) throw new Error(`Duplicate artifact path: ${file.name}`)
    names.add(file.name)
  }
  if (!names.has(input.metadata.entrypointPath)) {
    throw new Error('The configured entrypoint is missing from the artifact')
  }
  if (input.metadata.importMapPath && !names.has(input.metadata.importMapPath)) {
    throw new Error('The configured import map is missing from the artifact')
  }
  const extension = input.metadata.entrypointPath.split('.').pop()?.toLowerCase()
  if (!extension || !['ts', 'tsx', 'js', 'jsx', 'mjs'].includes(extension)) {
    throw new Error('The configured entrypoint type is unsupported')
  }
  const bundle = bundleSchema.parse({
    schema: 'supabase.fleet.functions.bundle.v1',
    files: input.files
      .map((file) => ({
        path: file.name,
        contentBase64: Buffer.from(file.content, 'utf8').toString('base64'),
        mode: 384 as const,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  })
  const artifact = Buffer.from(JSON.stringify(bundle), 'utf8')
  if (artifact.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(`Function artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte limit`)
  }
  return {
    artifact,
    digest: createHash('sha256').update(artifact).digest('hex'),
    size: artifact.byteLength,
    input,
  }
}

const deploymentRowSchema = z.object({
  project_ref: z.string(),
  slug: z.string(),
  generation: z.coerce.number().int().positive(),
  desired_revision: z.string().uuid(),
  desired_artifact_digest: digestSchema.nullable(),
  active_artifact_digest: digestSchema.nullable(),
  previous_artifact_digest: digestSchema.nullable(),
  operation_id: z.string(),
  adapter: z.enum(['compose', 'kubernetes']),
  state: z.enum([
    'queued',
    'activating',
    'probing',
    'active',
    'rolled-back',
    'failed',
    'manual-intervention',
    'deleted',
  ]),
  last_error_code: z.string().nullable(),
  remediation: z.string().nullable(),
  evidence: z
    .object({
      schema: z.literal('supabase.fleet.functions.deploy.evidence.v1'),
      status: z.string(),
      adapter: z.enum(['compose', 'kubernetes']),
      slug: z.string(),
      artifactDigest: digestSchema.optional(),
      previousDigest: digestSchema.optional(),
      observedGeneration: z.number().int().positive(),
      probe: z.object({ succeeded: z.boolean(), message: z.string().optional() }),
      activatedAt: z.string(),
      remediation: z.string().optional(),
    })
    .nullable()
    .default(null),
  observed_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

export type FunctionDeployment = {
  projectRef: string
  slug: string
  generation: number
  desiredRevision: string
  desiredArtifactDigest: string | null
  activeArtifactDigest: string | null
  previousArtifactDigest: string | null
  operationId: string
  adapter: 'compose' | 'kubernetes'
  state: z.infer<typeof deploymentRowSchema>['state']
  lastErrorCode: string | null
  remediation: string | null
  evidence: z.infer<typeof deploymentRowSchema>['evidence']
  observedAt: string | null
  createdAt: string
  updatedAt: string
}

function mapDeployment(value: unknown): FunctionDeployment {
  const row = deploymentRowSchema.parse(value)
  return {
    projectRef: row.project_ref,
    slug: row.slug,
    generation: row.generation,
    desiredRevision: row.desired_revision,
    desiredArtifactDigest: row.desired_artifact_digest,
    activeArtifactDigest: row.active_artifact_digest,
    previousArtifactDigest: row.previous_artifact_digest,
    operationId: row.operation_id,
    adapter: row.adapter,
    state: row.state,
    lastErrorCode: row.last_error_code,
    remediation: row.remediation,
    evidence: row.evidence,
    observedAt: row.observed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const deploymentSelect = `select project_ref, slug, generation, desired_revision,
  desired_artifact_digest, active_artifact_digest, previous_artifact_digest,
  operation_id, adapter, state, last_error_code, remediation, evidence, observed_at,
  created_at, updated_at from platform.function_deployments`

export async function listFunctionDeployments(projectRef: string): Promise<FunctionDeployment[]> {
  if (!projectRef) throw new Error('projectRef is required')
  const result = await executePlatformQuery({
    query: `${deploymentSelect} where project_ref = $1 and state <> 'deleted' order by slug`,
    parameters: [projectRef],
  })
  if (result.error) throw result.error
  return (result.data ?? []).map(mapDeployment)
}

export async function getFunctionDeployment(projectRef: string, slug: string) {
  const result = await executePlatformQuery({
    query: `${deploymentSelect} where project_ref = $1 and slug = $2`,
    parameters: [projectRef, functionSlugSchema.parse(slug)],
  })
  if (result.error) throw result.error
  return result.data?.[0] === undefined ? null : mapDeployment(result.data[0])
}

type CommitInput = {
  projectRef: string
  action: 'deploy' | 'delete'
  slug: string
  expectedGeneration: number
  idempotencyKey: string
  artifactDigest: string
  artifactSize: number
  entrypointPath: string
  importMapPath: string
  staticPatterns: string[]
  verifyJwt: boolean
  actor: string
  correlationId: string
}

async function commitDeployment(input: CommitInput): Promise<FunctionDeployment> {
  const operationId = `fn_${randomUUID()}`
  const result = await executePlatformQuery({
    query: `select * from platform.commit_function_deployment(
      $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14
    )`,
    parameters: [
      input.projectRef,
      input.slug,
      input.action,
      input.artifactDigest,
      input.artifactSize,
      input.entrypointPath,
      input.importMapPath,
      JSON.stringify(input.staticPatterns),
      input.verifyJwt,
      input.expectedGeneration,
      operationId,
      input.idempotencyKey,
      input.actor,
      input.correlationId,
    ],
  })
  if (result.error) {
    for (const code of [
      'configuration_conflict',
      'capability_unavailable',
      'management_target_unbound',
      'ownership_conflict',
      'artifact_conflict',
      'idempotency_conflict',
    ] as const) {
      if (result.error.message.includes(code)) {
        throw new FunctionDeploymentConflict(code, result.error.message)
      }
    }
    throw result.error
  }
  const deployment = await getFunctionDeployment(input.projectRef, input.slug)
  if (!deployment) throw new Error('Function deployment disappeared after commit')
  return deployment
}

async function requireFunctionBinding(projectRef: string) {
  await requireProjectCapability(projectRef, 'functions.deploy')
  const binding = await getProjectManagementBinding(projectRef)
  if (!binding || binding.state !== 'active' || binding.targetState !== 'active') {
    throw new ManagementTrustConflict(
      'management_target_unbound',
      'An active management binding and Agent are required for function deployment.'
    )
  }
  if (!['compose', 'kubernetes'].includes(binding.deploymentKind)) {
    throw new ManagementTrustConflict(
      'capability_unavailable',
      'Edge Function deployment supports Compose and Kubernetes targets.'
    )
  }
  const ownership = (await listProjectOwnershipPolicies(projectRef)).find(
    (policy) => policy.domain === 'functions'
  )
  if (!ownership || ownership.ownershipMode !== 'direct-managed') {
    throw new FunctionDeploymentConflict(
      'ownership_conflict',
      'Set the functions ownership policy to direct-managed before deploying.'
    )
  }
  return binding
}

export class FunctionDeploymentConflict extends Error {
  constructor(
    readonly code:
      | 'configuration_conflict'
      | 'capability_unavailable'
      | 'management_target_unbound'
      | 'ownership_conflict'
      | 'artifact_conflict'
      | 'idempotency_conflict',
    message: string
  ) {
    super(message)
    this.name = 'FunctionDeploymentConflict'
  }
}

export async function deployFunction(input: {
  projectRef: string
  value: z.infer<typeof functionDeploymentInputSchema>
  actor: string
  correlationId: string
}) {
  const binding = await requireFunctionBinding(input.projectRef)
  const built = buildFunctionArtifact(input.value)
  const response = await requestManagementDomain(binding, 'fleet-control', {
    method: 'PUT',
    path: `/platform/fleet/v1/projects/${encodeURIComponent(input.projectRef)}/function-artifacts/${built.digest}`,
    body: built.artifact,
    contentType: 'application/vnd.supabase.function-bundle+json',
    headers: {
      'X-Function-Slug': built.input.slug,
      'X-Function-Entrypoint': built.input.metadata.entrypointPath,
    },
    scopes: ['fleet.artifacts.write'],
    actor: input.actor,
    correlationId: input.correlationId,
    idempotencyKey: built.input.idempotencyKey,
  })
  z.object({ digest: z.literal(built.digest), size: z.literal(built.size) }).parse(response)
  return commitDeployment({
    projectRef: input.projectRef,
    action: 'deploy',
    slug: built.input.slug,
    expectedGeneration: built.input.expectedGeneration,
    idempotencyKey: built.input.idempotencyKey,
    artifactDigest: built.digest,
    artifactSize: built.size,
    entrypointPath: built.input.metadata.entrypointPath,
    importMapPath: built.input.metadata.importMapPath ?? '',
    staticPatterns: built.input.metadata.staticPatterns,
    verifyJwt: built.input.metadata.verifyJwt,
    actor: input.actor,
    correlationId: input.correlationId,
  })
}

export async function deleteFunction(input: {
  projectRef: string
  value: z.infer<typeof functionDeleteInputSchema>
  actor: string
  correlationId: string
}) {
  await requireFunctionBinding(input.projectRef)
  const value = functionDeleteInputSchema.parse(input.value)
  return commitDeployment({
    projectRef: input.projectRef,
    action: 'delete',
    slug: value.slug,
    expectedGeneration: value.expectedGeneration,
    idempotencyKey: value.idempotencyKey,
    artifactDigest: '',
    artifactSize: 0,
    entrypointPath: '',
    importMapPath: '',
    staticPatterns: [],
    verifyJwt: false,
    actor: input.actor,
    correlationId: input.correlationId,
  })
}

export async function downloadFunctionArtifact(input: {
  projectRef: string
  digest: string
  actor: string
  correlationId: string
}) {
  digestSchema.parse(input.digest)
  await requireProjectCapability(input.projectRef, 'functions.read')
  const binding = await getProjectManagementBinding(input.projectRef)
  if (!binding || binding.targetState !== 'active') {
    throw new FunctionDeploymentConflict(
      'management_target_unbound',
      'An active management target is required to read function artifacts.'
    )
  }
  const raw = await requestManagementDomain(binding, 'fleet-control', {
    method: 'GET',
    path: `/platform/fleet/v1/projects/${encodeURIComponent(input.projectRef)}/function-artifacts/${input.digest}`,
    scopes: ['fleet.artifacts.read'],
    actor: input.actor,
    correlationId: input.correlationId,
    responseType: 'buffer',
    maxResponseBytes: MAX_ARTIFACT_BYTES,
  })
  const downloaded = z
    .object({
      body: z.instanceof(Buffer),
      contentType: z.literal('application/vnd.supabase.function-bundle+json'),
    })
    .parse(raw)
  const digest = createHash('sha256').update(downloaded.body).digest('hex')
  if (digest !== input.digest) throw new Error('Downloaded function artifact digest changed')
  const bundle = bundleSchema.parse(JSON.parse(downloaded.body.toString('utf8')))
  return bundle.files.map((file) => ({
    path: file.path,
    content: Buffer.from(file.contentBase64, 'base64'),
  }))
}
