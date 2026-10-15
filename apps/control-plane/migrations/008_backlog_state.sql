-- Flow guards: a backlog that stopped itself (consecutive failures) stays halted across restarts until resumed.
CREATE TABLE IF NOT EXISTS backlog_state (
  employee_id        text NOT NULL REFERENCES employees(id),
  backlog_id         text NOT NULL,
  halted_at          timestamptz,
  halted_reason      text,
  resumed_at         timestamptz,
  alerted_budget_on  text,
  PRIMARY KEY (employee_id, backlog_id)
);
