-- The role that created a conversation's stored Claude session. A message handled by a different role
-- starts a fresh session instead of resuming one whose system prompt and tools belong to another role.
-- Existing rows keep session_role NULL: their creator is unknown, so the next message starts fresh once.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS session_role text;
