#!/usr/bin/env bash
# Reapply the Cloud Run stack with secrets from ../../.env. Usage: ./apply.sh <control-plane-tag> <runner-tag>
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ../../.env; set +a
CP_TAG=${1:?control-plane image tag}; RUNNER_TAG=${2:?runner image tag}; shift 2
REPO=us-central1-docker.pkg.dev/${GCP_PROJECT:?set GCP_PROJECT in .env}/ai-employee
export TF_VAR_project_id=${GCP_PROJECT:?set GCP_PROJECT in .env} TF_VAR_db_password="$DB_PASSWORD" \
  TF_VAR_control_plane_image=$REPO/control-plane:$CP_TAG TF_VAR_runner_image=$REPO/runner:$RUNNER_TAG TF_VAR_runner_ops_image=$REPO/runner-ops:$RUNNER_TAG \
  TF_VAR_claude_code_oauth_token="${CLAUDE_CODE_OAUTH_TOKEN:-}" TF_VAR_clickup_api_token="${CLICKUP_API_TOKEN:-}" \
  TF_VAR_clickup_webhook_secret="${CLICKUP_WEBHOOK_SECRET:-}" TF_VAR_clickup_chat_secret="${CLICKUP_CHAT_SECRET:-}" \
  TF_VAR_gh_token="${GH_TOKEN:-}" TF_VAR_azure_client_secret="${AZURE_CLIENT_SECRET:-}" \
  TF_VAR_public_base_url="${PUBLIC_BASE_URL_CLOUD:-}" \
  TF_VAR_env="{\"DEFAULT_EMPLOYEE_ID\":\"dev\",\"CLICKUP_TEAM_ID\":\"${CLICKUP_TEAM_ID:-}\",\"ROLES_DIR\":\"/app/apps/control-plane/roles\",\"LOG_LEVEL\":\"info\"}"
terraform apply -input=false "$@"
