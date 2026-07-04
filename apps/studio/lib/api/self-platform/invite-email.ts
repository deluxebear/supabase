// [self-platform] Invitation email delivery (M3.2). New users get GoTrue's
// /invite (creates + mails an invite link); existing users get a /otp magiclink
// (create_user:false). Both carry redirect_to=<SITE_URL>/join?token&slug so the
// verified session lands on the join page. Delivery goes through the platform
// GoTrue SMTP config (Mailpit locally). Throws on failure so the create route
// deletes the just-created row (invariant: a pending row means an email went
// out). Zero new npm deps — GoTrue does the mailing, mint-jwt signs the admin
// bearer.
import { PLATFORM_GOTRUE_URL, PLATFORM_JWT_SECRET, PLATFORM_SITE_URL } from './constants'
import { mintServiceJwt } from './mint-jwt'

function joinUrl(orgSlug: string, token: string): string {
  const q = new URLSearchParams({ token, slug: orgSlug })
  return `${PLATFORM_SITE_URL}/join?${q.toString()}`
}

// GoTrue signals an existing account on /invite with a 4xx + one of these codes
// (verified live, Task 7 spike). Anything else is a hard failure.
function isAlreadyRegistered(status: number, body: unknown): boolean {
  if (status !== 422 && status !== 400 && status !== 409) return false
  const code =
    typeof body === 'object' && body !== null
      ? String(
          (body as { error_code?: unknown; code?: unknown }).error_code ??
            (body as { code?: unknown }).code ??
            ''
        )
      : ''
  const msg =
    typeof body === 'object' && body !== null ? String((body as { msg?: unknown }).msg ?? '') : ''
  return /exist|registered/i.test(`${code} ${msg}`)
}

export async function sendInvitationEmail(input: {
  email: string
  orgSlug: string
  token: string
}): Promise<void> {
  const redirect_to = joinUrl(input.orgSlug, input.token)
  const bearer = `Bearer ${mintServiceJwt(PLATFORM_JWT_SECRET, 'service_role', 60)}`

  const inviteRes = await fetch(`${PLATFORM_GOTRUE_URL}/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: bearer },
    body: JSON.stringify({ email: input.email, data: { org_slug: input.orgSlug }, redirect_to }),
  })
  if (inviteRes.ok) return

  const inviteBody = await inviteRes.json().catch(() => ({}))
  if (!isAlreadyRegistered(inviteRes.status, inviteBody)) {
    throw new Error(
      `invite email failed (${inviteRes.status}): ${
        typeof (inviteBody as { msg?: unknown }).msg === 'string'
          ? (inviteBody as { msg: string }).msg
          : 'unknown'
      }`
    )
  }

  // Existing account → magiclink that lands on /join.
  const otpRes = await fetch(`${PLATFORM_GOTRUE_URL}/otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: input.email, create_user: false, redirect_to }),
  })
  if (!otpRes.ok) {
    const otpBody = await otpRes.json().catch(() => ({}))
    throw new Error(
      `magiclink email failed (${otpRes.status}): ${
        typeof (otpBody as { msg?: unknown }).msg === 'string'
          ? (otpBody as { msg: string }).msg
          : 'unknown'
      }`
    )
  }
}
