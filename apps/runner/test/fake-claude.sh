#!/bin/sh
# Fixture Claude Code. Prints stream-json NDJSON then exits 0.
# FAKE_ARGS_LOG=<file>: append argv per invocation.  FAKE_DEAD_RESUME=1: a `--resume` call behaves like a
# missing session (real CLI: exit 0, lone is_error result with num_turns 0, "No conversation found" on stderr).
# FAKE_LIMIT_TIMES=N (with FAKE_COUNT_FILE): the first N invocations end on the usage-limit result (exit 1), like `claude -p`
# at a subscription limit. FAKE_ENV_LOG=<file>: append the OAuth token each invocation sees.
[ -n "$FAKE_ARGS_LOG" ] && printf '%s\n' "$*" >> "$FAKE_ARGS_LOG"
[ -n "$FAKE_ENV_LOG" ] && printf '%s\n' "$CLAUDE_CODE_OAUTH_TOKEN" >> "$FAKE_ENV_LOG"
if [ -n "$FAKE_LIMIT_TIMES" ]; then
  n=$(cat "$FAKE_COUNT_FILE" 2>/dev/null || echo 0)
  n=$((n + 1))
  echo "$n" > "$FAKE_COUNT_FILE"
  if [ "$n" -le "$FAKE_LIMIT_TIMES" ]; then
    echo '{"type":"system","subtype":"init","model":"claude-opus-4","session_id":"sess-123"}'
    echo '{"type":"result","subtype":"success","is_error":true,"result":"You'"'"'ve hit your session limit · resets 5:40pm (UTC)","num_turns":1,"total_cost_usd":0}'
    exit 1
  fi
fi
case " $* " in *" --resume "*)
  if [ "$FAKE_DEAD_RESUME" = "1" ]; then
    echo "No conversation found with session ID: sess-old" >&2
    echo '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"session_id":"sess-old","total_cost_usd":0}'
    exit 0
  fi
esac
cat <<'NDJSON'
{"type":"system","subtype":"init","model":"claude-opus-4","session_id":"sess-123"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","content":"file1\nfile2","is_error":false}]}}
{"type":"result","subtype":"success","result":"Done","total_cost_usd":0.01,"duration_ms":1234,"num_turns":2}
NDJSON
exit 0
