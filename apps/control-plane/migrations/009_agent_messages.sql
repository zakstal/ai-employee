-- Agent-to-agent messaging: a per-employee channel any task can post to and poll. body is an A2A Message.
CREATE TABLE IF NOT EXISTS agent_messages (
  id           bigserial PRIMARY KEY,
  employee_id  text NOT NULL REFERENCES employees(id),
  channel      text NOT NULL,
  from_task_id text NOT NULL REFERENCES tasks(id),
  to_task_id   text REFERENCES tasks(id),
  body         jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_messages_channel_idx ON agent_messages (employee_id, channel, id);
