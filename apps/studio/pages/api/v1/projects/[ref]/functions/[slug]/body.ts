import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { type NextApiRequest, type NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { getFunctionsArtifactStore } from '@/lib/api/self-hosted/functions'
import { requireProjectCapability } from '@/lib/api/self-platform/attachment'
import {
  downloadFunctionArtifact,
  getFunctionDeployment,
} from '@/lib/api/self-platform/function-deployments'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'
import { uuidv4 } from '@/lib/helpers'

export default function handlerWithErrorCatching(req: NextApiRequest, res: NextApiResponse) {
  return apiWrapper(req, res, handler, { withAuth: true })
}

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  const { method } = req

  // [self-platform] M3.1 RBAC guard (M3.0 final-review I2 first batch).
  // 404-before-403 lives inside guardProjectRoute (resolver-first). Note the
  // Embedded keeps the upstream mounted directory contract. Fleet branches to
  // the project-scoped platform artifact authority below.
  if (IS_SELF_PLATFORM && method === 'GET') {
    const ok = await guardProjectRoute(res, claims, {
      action: PermissionAction.FUNCTIONS_READ,
      projectRef: String(req.query.ref),
    })
    if (!ok) return
  }

  switch (method) {
    case 'GET':
      if (STUDIO_DEPLOYMENT_PROFILE === 'fleet') {
        return handleFleetGet(req, res, claims)
      }
      return handleGet(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

async function handleFleetGet(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  const slugParam = req.query.slug
  const slug = Array.isArray(slugParam) ? slugParam[0] : slugParam
  if (!slug) return res.status(404).json({ error: { message: `Function not found` } })
  const projectRef = String(req.query.ref)
  await requireProjectCapability(projectRef, 'functions.read')
  const deployment = await getFunctionDeployment(projectRef, slug)
  const digest = deployment?.activeArtifactDigest ?? deployment?.desiredArtifactDigest
  if (!deployment || deployment.state === 'deleted' || !digest) {
    return res.status(404).json({ error: { message: `Function artifact not found` } })
  }
  const files = await downloadFunctionArtifact({
    projectRef,
    digest,
    actor: claims?.sub ?? 'unknown',
    correlationId: uuidv4(),
  })
  const boundary = `----FormBoundary${uuidv4().replace(/-/g, '')}`
  const totalSize = files.reduce((sum, entry) => sum + entry.content.length, 0)
  res.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`)
  res.status(200)
  res.write(
    `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ deployment_id: deployment.operationId, original_size: totalSize, compressed_size: deployment.desiredArtifactDigest ? totalSize : 0, module_count: files.length })}\r\n`
  )
  for (const file of files) {
    const safeName = file.path
      .replace(/[\r\n]/g, '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
    res.write(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(file.path)}\r\nContent-Type: text/plain\r\n\r\n`
    )
    res.write(file.content)
    res.write(`\r\n`)
  }
  res.write(`--${boundary}--\r\n`)
  res.end()
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const slugParam = req.query.slug
  const slug = Array.isArray(slugParam) ? slugParam[0] : slugParam
  if (!slug) {
    res.status(404).json({ error: { message: `Missing function 'slug' parameter` } })
    return
  }

  const store = getFunctionsArtifactStore()
  const fileEntries = await store.getFileEntriesBySlug(slug)

  const boundary = `----FormBoundary${uuidv4().replace(/-/g, '')}`
  const totalSize = fileEntries.reduce((sum, entry) => sum + entry.size, 0)

  const metadata = {
    // mock id, should be "<project_id>_<function_id>_<version>"
    deployment_id: uuidv4(),
    original_size: totalSize,
    compressed_size: totalSize,
    module_count: fileEntries.length,
  }

  res.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`)
  res.status(200)

  // Write metadata part
  const metadataJson = JSON.stringify(metadata)
  res.write(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="metadata"\r\n` +
      `Content-Type: application/json\r\n` +
      `\r\n` +
      metadataJson +
      `\r\n`
  )

  // Stream each file part
  for (const entry of fileEntries) {
    const safeName = entry.relativePath
      .replace(/[\r\n]/g, '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
    const encodedName = encodeURIComponent(entry.relativePath)
    res.write(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${safeName}"; filename*=UTF-8''${encodedName}\r\n` +
        `Content-Type: text/plain\r\n` +
        `\r\n`
    )
    await pipeline(createReadStream(entry.absolutePath), res, { end: false })
    res.write(`\r\n`)
  }

  // Write closing boundary
  res.write(`--${boundary}--\r\n`)
  res.end()
}
