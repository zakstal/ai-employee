CREATE TABLE IF NOT EXISTS employees (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   text NOT NULL REFERENCES employees(id),
  channel       text NOT NULL,
  external_ref  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_ref)
);

CREATE TABLE IF NOT EXISTS tasks (
  id               text PRIMARY KEY,            -- == workflow id == dedup key
  employee_id      text NOT NULL REFERENCES employees(id),
  conversation_id  uuid REFERENCES conversations(id),
  role_id          text NOT NULL,
  prompt           text NOT NULL,
  source           jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'queued',
  run_handle       jsonb,
  result           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_employee_status_idx ON tasks (employee_id, status);

CREATE TABLE IF NOT EXISTS task_events (
  id          bigserial PRIMARY KEY,
  task_id     text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  type        text NOT NULL,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, seq)
);

CREATE TABLE IF NOT EXISTS run_tokens (
  token_hash  text PRIMARY KEY,
  task_id     text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL
);
