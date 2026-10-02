-- Manager wake state. One row per employee. `wake_pending` is set when a backlog task finishes and
-- cleared when the manager actually runs, so a burst of completions produces a single wake.
CREATE TABLE IF NOT EXISTS manager_state (
  employee_id  text PRIMARY KEY REFERENCES employees(id),
  wake_pending boolean NOT NULL DEFAULT false,
  wake_reason  text,
  last_wake_at timestamptz
);
