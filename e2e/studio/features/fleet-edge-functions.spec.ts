import { expect } from '@playwright/test'

import { test } from '../utils/test.js'

const projectA = process.env.FLEET_E2E_PROJECT_A
const projectB = process.env.FLEET_E2E_PROJECT_B

test.describe('Fleet Edge Function project isolation', () => {
  test.skip(
    !projectA || !projectB,
    'FLEET_E2E_PROJECT_A and FLEET_E2E_PROJECT_B must name two attached direct-managed Fleet projects'
  )

  test('keeps equal slugs and immutable artifacts isolated by project', async ({ page }) => {
    const slug = `e2e-${Date.now()}`
    const endpoint = (ref: string) => `/api/platform/fleet/v1/projects/${ref}/functions`
    const deploy = async (ref: string, marker: string) => {
      const response = await page.request.post(endpoint(ref), {
        headers: { 'Idempotency-Key': `${slug}:${ref}:deploy` },
        data: {
          slug,
          expectedGeneration: 0,
          metadata: { entrypointPath: 'index.ts', staticPatterns: [], verifyJwt: true },
          files: [
            {
              name: 'index.ts',
              content: `Deno.serve(() => new Response(${JSON.stringify(marker)}))`,
            },
          ],
        },
      })
      expect(response.status()).toBe(202)
      return (await response.json()).deployment as {
        projectRef: string
        generation: number
        desiredArtifactDigest: string
      }
    }

    const deploymentA = await deploy(projectA!, 'project-a')
    const deploymentB = await deploy(projectB!, 'project-b')
    try {
      expect(deploymentA.projectRef).toBe(projectA)
      expect(deploymentB.projectRef).toBe(projectB)
      expect(deploymentA.desiredArtifactDigest).not.toBe(deploymentB.desiredArtifactDigest)

      for (const [ref, own, foreign] of [
        [projectA!, deploymentA.desiredArtifactDigest, deploymentB.desiredArtifactDigest],
        [projectB!, deploymentB.desiredArtifactDigest, deploymentA.desiredArtifactDigest],
      ] as const) {
        const response = await page.request.get(endpoint(ref))
        expect(response.status()).toBe(200)
        const body = (await response.json()) as {
          functions: Array<{
            projectRef: string
            slug: string
            desiredArtifactDigest: string | null
          }>
        }
        const matching = body.functions.filter((item) => item.slug === slug)
        expect(matching).toEqual([
          expect.objectContaining({ projectRef: ref, desiredArtifactDigest: own }),
        ])
        expect(body.functions).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ desiredArtifactDigest: foreign })])
        )
      }
    } finally {
      await Promise.all(
        [
          [projectA!, deploymentA.generation],
          [projectB!, deploymentB.generation],
        ].map(([ref, expectedGeneration]) =>
          page.request.delete(endpoint(ref), {
            headers: { 'Idempotency-Key': `${slug}:${ref}:delete` },
            data: { slug, expectedGeneration },
          })
        )
      )
    }
  })
})
