ALTER TABLE operations ADD COLUMN desired_revision TEXT NOT NULL DEFAULT '';
ALTER TABLE operations ADD COLUMN desired_digest TEXT NOT NULL DEFAULT '';
ALTER TABLE operations ADD COLUMN snapshot_canonical TEXT NOT NULL DEFAULT '{}';
