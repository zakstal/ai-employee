-- Claude subscription accounts: last probed usage per account, which account each task runs on, and runtime-switchable settings.
CREATE TABLE IF NOT EXISTS engine_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS claude_account_usage (
  name                    text PRIMARY KEY,
  fingerprint             text NOT NULL,
  unified_status          text,
  representative_claim    text,
  five_hour_status        text,
  five_hour_utilization   double precision,
  five_hour_reset         timestamptz,
  seven_day_status        text,
  seven_day_utilization   double precision,
  seven_day_reset         timestamptz,
  overage_status          text,
  overage_utilization     double precision,
  overage_reset           timestamptz,
  overage_disabled_reason text,
  checked_at              timestamptz,
  last_error              text,
  -- the window (by its reset time) the warn-threshold alert was last sent for: once per window
  alerted_five_hour_reset timestamptz,
  alerted_seven_day_reset timestamptz
);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claude_account text;
