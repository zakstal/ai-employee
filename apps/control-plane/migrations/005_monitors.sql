-- Monitors: deterministic collectors defined in the employee YAML; this table holds their runtime state.
-- Absent row == disabled. Default OFF by design.
CREATE TABLE IF NOT EXISTS monitors (
  employee_id     text NOT NULL REFERENCES employees(id),
  name            text NOT NULL,
  enabled         boolean NOT NULL DEFAULT false,
  state           jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_run_at     timestamptz,
  last_fired_at   timestamptz,
  updated_by_task text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, name)
);
