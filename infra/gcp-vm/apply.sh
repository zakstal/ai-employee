#!/usr/bin/env bash
# Reapply the always-on VM stack. Usage: ./apply.sh <control-plane-tag> <runner-tag> [terraform apply flags...]
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ../../.env; set +a
# Pin the GCP identity: the shared gcloud config on this Mac flips between accounts.
if ! grep -q "^AZURE_BROKER_SECRET=" ../../.env; then echo "AZURE_BROKER_SECRET=$(openssl rand -base64 32 | tr -d "=+/")" >> ../../.env; set -a; . ../../.env; set +a; fi
export CLOUDSDK_CORE_ACCOUNT="${GCP_ACCOUNT:-you@example.com}"
CP_TAG=${1:?control-plane image tag}; RUNNER_TAG=${2:?runner image tag}; shift 2
REPO=us-central1-docker.pkg.dev/${GCP_PROJECT:-my-gcp-project}/ai-employee

# RUNNER_TOKEN is the shared secret between the control plane and the warm runner's
# HTTP API. Generate and persist one into ../../.env if it doesn't exist yet, so
# repeat applies reuse the same value instead of rotating it every time.
if ! grep -q '^RUNNER_TOKEN=' ../../.env 2>/dev/null; then
  echo "RUNNER_TOKEN=$(openssl rand -base64 32)" >> ../../.env
  set -a; . ../../.env; set +a
# Pin the GCP identity: the shared gcloud config on this Mac flips between accounts.
export CLOUDSDK_CORE_ACCOUNT="${GCP_ACCOUNT:-you@example.com}"
fi

export TF_VAR_project_id=${GCP_PROJECT:-my-gcp-project} \
  TF_VAR_control_plane_image=$REPO/control-plane:$CP_TAG TF_VAR_runner_image=$REPO/runner-ops:$RUNNER_TAG \
  TF_VAR_runner_token="$RUNNER_TOKEN" \
  TF_VAR_azbroker_image="${AZBROKER_IMAGE:-}" TF_VAR_azure_broker_secret="${AZURE_BROKER_SECRET:-}" \
  TF_VAR_azure_tenant_id="${AZURE_TENANT_ID:-}" TF_VAR_azure_subscription_id="${AZURE_SUBSCRIPTION_ID:-}" \
  TF_VAR_cloudsql_connection_name="${GCP_PROJECT:-my-gcp-project}:us-central1:ai-employee-pg" \
  TF_VAR_env="{\"DEFAULT_EMPLOYEE_ID\":\"dev\",\"CLICKUP_TEAM_ID\":\"${CLICKUP_TEAM_ID:-}\",\"LOG_LEVEL\":\"info\",\"ALERT_CHANNEL_ID\":\"${ALERT_CHANNEL_ID:-}\"}"
terraform apply -input=false "$@"

# Roll the new metadata out on the existing VM: re-run the startup script, which
# rewrites .env/compose and restarts only containers whose image or env changed.
ZONE=$(terraform output -raw zone 2>/dev/null || echo us-central1-b)
echo "rolling out on the VM (zone $ZONE)..."
gcloud compute ssh "${TF_VAR_name:-ai-employee}-vm" --zone "$ZONE" --project "$TF_VAR_project_id" --tunnel-through-iap --quiet \
  --command 'sudo google_metadata_script_runner startup && sudo docker ps --format "{{.Names}} {{.Image}} {{.Status}}"' 2>/dev/null | grep -E "^ai-employee-"
URL=$(terraform output -raw public_url)
for i in $(seq 1 30); do curl -sf "$URL/health" >/dev/null && { echo "healthy: $URL"; break; }; sleep 3; done
