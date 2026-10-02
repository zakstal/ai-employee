-- One Claude Code session per conversation: resumed with `claude --resume` on the next message.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS session_id text;
