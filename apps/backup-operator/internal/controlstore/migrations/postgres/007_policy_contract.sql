ALTER TABLE backup_policies ADD COLUMN IF NOT EXISTS retention_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE backup_policies ADD COLUMN IF NOT EXISTS full_schedule TEXT;
ALTER TABLE backup_policies ADD COLUMN IF NOT EXISTS diff_schedule TEXT;
ALTER TABLE backup_policies ADD COLUMN IF NOT EXISTS incr_schedule TEXT;
