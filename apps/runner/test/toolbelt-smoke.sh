#!/usr/bin/env bash
# docker run --rm --entrypoint bash <image> /app/apps/runner/test/toolbelt-smoke.sh [ops]
set -u
fail=0
check() { if command -v "$1" >/dev/null 2>&1; then printf '%-12s %s\n' "$1" "$("$@" 2>&1 | head -1)"; else echo "MISSING: $1"; fail=1; fi; }
check node --version; check git --version; check gh --version; check rg --version; check jq --version; check claude --version
command -v clickup-mcp >/dev/null && echo "clickup-mcp  $(command -v clickup-mcp)" || { echo "MISSING: clickup-mcp"; fail=1; }
if [ "${1:-}" = ops ]; then
  check az version
  az group delete -n x >/dev/null 2>&1; rc=$?; [ $rc = 77 ] && echo "az guard      refuses mutating verbs (exit 77)" || { echo "az guard BROKEN: delete returned $rc"; fail=1; }
  az group list --help >/dev/null 2>&1 && echo "az guard      allows list" || { echo "az guard BROKEN: list refused"; fail=1; }
fi
[ "$(id -u)" = 1000 ] || { echo "not uid 1000"; fail=1; }
echo "EXIT=$fail"; exit $fail
