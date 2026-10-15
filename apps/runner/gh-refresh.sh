#!/bin/sh
# Installed as /usr/local/bin/gh (ahead of /usr/bin/gh). On a run whose GitHub login is a short-lived token
# (GH_TOKEN_REFRESH names the grant) every gh call first picks up a fresh GH_TOKEN; otherwise it is a plain passthrough.
if [ -n "${GH_TOKEN_REFRESH:-}" ]; then
  t=$(ai-employee-credential env GH_TOKEN 2>/dev/null) && [ -n "$t" ] && export GH_TOKEN="$t"
fi
exec /usr/bin/gh "$@"
