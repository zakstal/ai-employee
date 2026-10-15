-- 'runtime' = created by an agent over HTTP; 'config' = reconciled from the employee file at boot.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'runtime';
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS config_hash text;
