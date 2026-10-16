-- Whether the account is billing paid overage right now (header overage-in-use), as opposed to overage_utilization, the month's meter.
ALTER TABLE claude_account_usage ADD COLUMN IF NOT EXISTS overage_in_use boolean;
