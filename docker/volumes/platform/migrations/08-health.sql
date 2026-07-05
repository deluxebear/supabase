-- M6.0: last time a health probe wrote back an observed status. NULL = never
-- probed (the row shows its registration-time status until the first
-- observation). Written by the health routes' write-through (health.ts);
-- the register CLI does not touch it.
alter table platform.projects add column if not exists last_health_at timestamptz;
