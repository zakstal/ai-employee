-- Notes an agent leaves for the owner's local Claude Code session (note_for_owner_session). The local session polls
-- GET /notes and acknowledges with POST /notes/:id/ack. Stored only: nothing is pushed to any chat.
CREATE TABLE IF NOT EXISTS owner_notes (
  id           bigserial PRIMARY KEY,
  employee_id  text NOT NULL REFERENCES employees(id),
  from_task_id text REFERENCES tasks(id),
  role_id      text,
  text         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  acked_at     timestamptz
);

CREATE INDEX IF NOT EXISTS owner_notes_pending_idx ON owner_notes (id) WHERE acked_at IS NULL;
