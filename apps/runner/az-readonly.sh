#!/usr/bin/env bash
# Read-only guard in front of the Azure CLI. Installed as /usr/local/bin/az (ahead of /usr/bin/az).
# The runner's tool allowlist only permits `az ...`, so this wrapper is the only way the agent reaches az.
# Allowed: login/account plumbing, and read verbs. Everything else (create/delete/update/set/start/stop/...) is refused.
set -u
REAL=/usr/bin/az
[ "${AZ_READONLY:-1}" = "0" ] && exec "$REAL" "$@"

allowed=0
case "${1:-} ${2:-}" in
  "login "*|"logout "*|"account show"|"account list"|"account set"|"account get-access-token"|"version "*|"upgrade "*|"config get"|"extension list"|"extension show") allowed=1 ;;
esac
if [ $allowed -eq 0 ]; then
  # Any argument that is a bare verb decides. Read verbs pass; anything mutating fails closed.
  for a in "$@"; do
    case "$a" in
      show|list|list-*|show-*|get|get-*|query|check-name|export|download|wait|validate|what-if|browse|log|tail|metrics|describe) allowed=1; break ;;
      create|delete|update|set|start|stop|restart|deploy|deployment|remove|add|import|purge|restore|scale|swap|upload|move|assign|revoke|grant|reset|regenerate|rotate|enable|disable|apply|run|exec|invoke|trigger|publish|sync|attach|detach|link|unlink|promote|failover|cancel|approve|reject|lock|unlock|recover|reimage|redeploy|resize|rename|tag|untag|write|put|patch|post) allowed=0; break ;;
    esac
  done
fi
if [ $allowed -eq 1 ]; then exec "$REAL" "$@"; fi
echo "az (read-only guard): refusing '$*'. This runner only permits read operations (show/list/get/query/monitor). Ask a human to make changes." >&2
exit 77
