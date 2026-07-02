-- M2.1: per-project analytics (Logflare) target. Nullable — NULL means
-- analytics is not configured for this project (Studio's Logs routes return
-- 404 for it; they never fall back to the global stack's Logflare).
-- logflare_url stores the BASE url (the per-project LOGFLARE_URL equivalent,
-- no /api/ suffix). logflare_token_enc is AES-encrypted with
-- PLATFORM_ENCRYPTION_KEY, same scheme as the other *_enc columns.
alter table platform.projects add column if not exists logflare_url text;
alter table platform.projects add column if not exists logflare_token_enc text;
