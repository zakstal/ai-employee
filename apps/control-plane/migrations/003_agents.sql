ALTER TABLE tasks
  ADD COLUMN parent_task_id text REFERENCES tasks(id),
  ADD COLUMN depth int NOT NULL DEFAULT 0,
  ADD COLUMN question text,
  ADD COLUMN answer text;

CREATE INDEX IF NOT EXISTS tasks_parent_task_id_idx ON tasks (parent_task_id);
