export type DurableCapabilities = {
  multipart: boolean
  transactionMode: boolean
  loopContinueOnFailure: boolean
}

function parseVersion(version: string | null | undefined) {
  const match = version?.trim().match(/^(\d+)\.(\d+)\.(\d+)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export function compareDurableVersions(a: string, b: string) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]
  return 0
}

const atLeast = (version: string | null | undefined, minimum: string) =>
  !!version && (compareDurableVersions(version, minimum) ?? -1) >= 0

export function getDurableCapabilities(version: string | null | undefined): DurableCapabilities {
  return {
    multipart: atLeast(version, '0.2.5'),
    transactionMode: atLeast(version, '0.2.5'),
    loopContinueOnFailure: atLeast(version, '0.2.8'),
  }
}

export const capabilitiesFromConfiguration = (c: { installed_version: string | null }) =>
  getDurableCapabilities(c.installed_version)
