ALTER TABLE backup_policies ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE backup_policies ADD COLUMN full_schedule TEXT;
ALTER TABLE backup_policies ADD COLUMN diff_schedule TEXT;
ALTER TABLE backup_policies ADD COLUMN incr_schedule TEXT;
