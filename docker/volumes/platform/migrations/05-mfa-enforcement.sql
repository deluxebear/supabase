-- [self-platform] M3.1: org-level MFA enforcement flag. The flag is STORED
-- and exposed via GET/PATCH /organizations/{slug}/members/mfa/enforcement;
-- actual enforcement (blocking non-MFA members) lands with the M3.2
-- invite/join flow — see README "M3.1" section.
-- Idempotent: safe to re-run (03/04 precedent).
alter table platform.organizations
add column if not exists enforce_mfa boolean not null default false;
