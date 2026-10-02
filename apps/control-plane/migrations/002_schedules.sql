CREATE TABLE IF NOT EXISTS schedules (
  id               text PRIMARY KEY,
  employee_id      text NOT NULL REFERENCES employees(id),
  name             text NOT NULL,
  cron             text NOT NULL,
  timezone         text NOT NULL DEFAULT 'America/Los_Angeles',
  role_id          text NOT NULL,
  prompt           text NOT NULL,
  deliver_to       jsonb NOT NULL,
  created_by_task  text,
  enabled          boolean NOT NULL DEFAULT true,
  last_fired_at    timestamptz,
  next_fire_at     timestamptz NOT NULL,
  created_at       timestamptz DEFAULT now(),
  UNIQUE (employee_id, name)
);
CREATE INDEX IF NOT EXISTS schedules_enabled_next_fire_idx ON schedules (enabled, next_fire_at);
