// [self-platform] Invitation email delivery (M3.2). Task 7 fills this with the
// GoTrue dual-path (/invite for new users, /otp magiclink for existing) through
// the platform-auth SMTP sink. Until then this no-ops (RESOLVES): invitations
// are still created (row-only / "copy the link" degraded mode) so the create
// route + pipeline are built and tested in isolation. The create route mocks
// this in unit tests; the live GoTrue path is Task 7 + E2E.
export async function sendInvitationEmail(_input: {
  email: string
  orgSlug: string
  token: string
}): Promise<void> {
  return
}
