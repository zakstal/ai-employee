# infra/gcp-cloudrun

Terraform for the ai-employee control plane on Cloud Run + Cloud SQL Postgres
17, instead of the GKE Autopilot variant in `infra/gcp/`. Provider:
`hashicorp/google` `~> 8.2` (latest at time of writing, verified via the
Terraform Registry MCP — matches `infra/gcp/`).

- **Control plane** (`${name}-control-plane`): `google_cloud_run_v2_service`,
  always-on (`min_instance_count = var.min_instances`, default 1 — see
  "Why min_instances can't be 0" below), serving Slack/ClickUp webhooks and
  running DBOS workflows in-process.
- **Runner** (`${name}-runner`): `google_cloud_run_v2_job`, one execution per
  sandbox run, started on demand by the control plane with per-run env
  overrides (task id, employee id, credentials).
- **Cloud SQL** Postgres 17, one instance, two databases
  (`ai_employee`, `ai_employee_dbos`), one user (`ai`).

## Why min_instances can't be 0

The control plane calls `DBOS.launch()` in `src/main.ts` and polls DBOS
workflow state in-process for the life of the process. Cloud Run
scale-to-zero would suspend that process — and any workflow mid-step — the
moment traffic goes quiet. `variable "min_instances"` has a validation block
enforcing `>= 1` for this reason; treat lowering it as a correctness bug, not
a cost optimization.

## Why max_instance_count is pinned to 1

DBOS here runs as a single-node executor. A second concurrent Cloud Run
instance would mean two processes racing to claim the same durable workflow
steps. Going beyond 1 needs DBOS's multi-executor coordination configured
first — this stack doesn't attempt that.

## Bootstrap order

```bash
# 1. Auth
gcloud auth login
gcloud auth application-default login
gcloud config set project my-gcp-project   # or your project_id

# 2. Terraform init/plan without images yet is impossible (control_plane_image
#    and runner_image have no default) — build and push them first.
```

### 2. Build + push both images (amd64 — Cloud Run doesn't run arm64)

```bash
cd /path/to/ai-employee
REGISTRY=us-central1-docker.pkg.dev/my-gcp-project/ai-employee   # matches artifact_registry_url output, once it exists

# One-time: create the Artifact Registry repo before you can push to it —
# either `terraform apply -target=google_artifact_registry_repository.images`
# first, or `gcloud artifacts repositories create ai-employee --repository-format=docker --location=us-central1`.
gcloud auth configure-docker us-central1-docker.pkg.dev

docker buildx build --platform linux/amd64 \
  -f apps/control-plane/Dockerfile -t "$REGISTRY/control-plane:latest" --push .

docker buildx build --platform linux/amd64 \
  -f apps/runner/Dockerfile -t "$REGISTRY/runner:latest" --push .
```

### 3. Apply

Secrets and the DB password come from your `.env`, exported as `TF_VAR_*`:

```bash
cd infra/gcp-cloudrun
terraform init

set -a; . ../../.env; set +a
export TF_VAR_db_password="$DB_PASSWORD" \
  TF_VAR_slack_signing_secret="$SLACK_SIGNING_SECRET" \
  TF_VAR_slack_bot_token="$SLACK_BOT_TOKEN" \
  TF_VAR_claude_code_oauth_token="$CLAUDE_CODE_OAUTH_TOKEN" \
  TF_VAR_clickup_api_token="$CLICKUP_API_TOKEN" \
  TF_VAR_clickup_webhook_secret="$CLICKUP_WEBHOOK_SECRET" \
  TF_VAR_clickup_chat_secret="$CLICKUP_CHAT_SECRET" \
  TF_VAR_gh_token="$GH_TOKEN" \
  TF_VAR_azure_client_secret="$AZURE_CLIENT_SECRET"

terraform apply \
  -var="control_plane_image=$REGISTRY/control-plane:latest" \
  -var="runner_image=$REGISTRY/runner:latest"
```

Any `TF_VAR_*` left unset defaults to `""` — that secret gets created as an
empty shell (no version), and you add the value later with:

```bash
echo -n "<value>" | gcloud secrets versions add <secret-id> --data-file=-
```

### 4. Migrations

No separate migration step: the control plane runs `await migrate(config.DATABASE_URL)`
itself on boot, before it starts listening (`apps/control-plane/src/main.ts:18`).
The first successful revision rollout is the migration.

### 5. Set the real public URL and re-apply

```bash
terraform output -raw service_url
terraform apply \
  -var="control_plane_image=$REGISTRY/control-plane:latest" \
  -var="runner_image=$REGISTRY/runner:latest" \
  -var="public_base_url=$(terraform output -raw service_url)"
```

### 6. Register webhooks

Point Slack's event subscription URL and ClickUp's webhook/chat-automation
URLs at `terraform output -raw service_url`.

## Decisions this stack makes for you

- **Secret shells vs. versions**: every secret in `secrets.tf` is created
  regardless of whether you supplied a value (so `secret_key_ref`s in
  `cloudrun.tf` never point at a nonexistent secret); a version is only
  written when the corresponding `TF_VAR_*` is non-empty.
- **`GCP_PROJECT`, `GCP_REGION`, `CLOUDRUN_JOB_NAME`, `RUNNER_IMAGE`,
  `SANDBOX_RUNTIME`** are computed from other resources/variables in
  `locals.control_plane_env` (`cloudrun.tf`), not left for you to pass
  through `var.env` — they're already known to Terraform, so requiring the
  caller to duplicate them would just be one more place they can drift.
  `var.env` is for things this stack has no opinion on (e.g.
  `DEFAULT_EMPLOYEE_ID`); it's merged in last, so it can still override any
  computed value if you ever need to.
- **`azure-client-secret`** gets a secret shell but is not wired into the
  control-plane container's env — nothing in `config.ts`/`main.ts` currently
  reads it from there; wire it up if/when Azure IAM app-integrations moves
  onto this stack.
- **Runner has no extra IAM roles** beyond its bare service account, per
  spec — its actual sandbox permissions aren't decided yet.

## Extra runner images

`runner` and `runner-ops` are always created (5400s ceiling per run). Add images of your own (built FROM the runner)
with `extra_runner_images`, each with its own cpu/memory/timeout; see `variables.tf` for the shape.

## Cost note (us-central1, roughly)

- Cloud Run control plane, `min_instance_count = 1`, 1 vCPU / 1Gi, always-
  allocated CPU (`cpu_idle = false`): **~$15–25/mo**.
- Cloud SQL `db-f1-micro`, single zone, no HA: **~$10/mo** (plus a few
  dollars for the default disk and public IP).
- Runner Job: **$0 at rest** — Cloud Run Jobs only bill for execution time,
  and none are running until the control plane starts one.
- No load balancer — the Cloud Run service's own HTTPS URL is the ingress.
