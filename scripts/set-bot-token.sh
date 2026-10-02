#!/usr/bin/env bash
# Replace the bot's Claude subscription token in .env without it appearing on screen,
# in shell history, or in a conversation transcript. Usage: ./scripts/set-bot-token.sh
set -euo pipefail
cd "$(dirname "$0")/.."
read -rsp 'Paste the token from `claude setup-token`, then press Enter: ' TOKEN
echo
[ -n "${TOKEN:-}" ] || { echo "no token given, nothing changed" >&2; exit 1; }
case "$TOKEN" in
  sk-ant-oat*) ;;
  *) echo "that does not look like a setup-token (expected it to start sk-ant-oat)" >&2; exit 1;;
esac
cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"
TOKEN="$TOKEN" python3 - <<'PY'
import os, re
tok = os.environ["TOKEN"]
s = open(".env").read()
line = "CLAUDE_CODE_OAUTH_TOKEN=" + tok
s, n = re.subn(r"(?m)^CLAUDE_CODE_OAUTH_TOKEN=.*$", lambda _: line, s)
if n == 0:
    s = s.rstrip("\n") + "\n" + line + "\n"
open(".env", "w").write(s)
print("updated .env (" + ("replaced" if n else "added") + " the token)")
PY
echo "backup kept alongside .env; deploy to roll it out"
