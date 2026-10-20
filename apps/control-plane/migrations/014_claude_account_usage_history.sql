-- Every account usage reading, not only the latest (claude_account_usage keeps one row per account). The 5 h / 7 d
-- curves can then be matched to what was running (Zak, 2026-10-19: "we need to track usage and find out what's
-- actually happening"). One row per probe that read headers, plus one per limit hit seen in a task's output.
CREATE TABLE IF NOT EXISTS claude_account_usage_history (
  id                     bigserial PRIMARY KEY,
  name                   text NOT NULL,
  checked_at             timestamptz NOT NULL,
  source                 text NOT NULL DEFAULT 'probe',  -- 'probe' | 'limit'
  five_hour_status       text,
  five_hour_utilization  double precision,
  five_hour_reset        timestamptz,
  seven_day_status       text,
  seven_day_utilization  double precision,
  seven_day_reset        timestamptz,
  overage_status         text,
  overage_utilization    double precision,
  overage_in_use         boolean
);

CREATE INDEX IF NOT EXISTS claude_account_usage_history_name_at_idx ON claude_account_usage_history (name, checked_at);
