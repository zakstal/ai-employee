# Deploying

The control plane is one Node process (Fastify plus DBOS) with a Postgres database. Sandboxes run elsewhere: in an always-on runner
container, in Cloud Run jobs, in Kubernetes Jobs, or as local processes. The repo ships Terraform and manifests for Google Cloud. Other clouds
need the same pieces wired by hand: a Postgres database (the stacks use 17), somewhere to run two or three containers, and a public HTTPS URL for webhooks.

Everything here was read from the repo's Terraform, scripts and code. For this guide the local path was booted and a task was run against it with a stub Claude binary, and the
Caddy rule below was tested with Caddy 2. The cloud paths were read, not applied; where a step is inferred rather than shipped, it says so.

Contents: [choose a path](#choose-a-path) · [prerequisites](#prerequisites) · [build images](#build-and-push-images) ·
[A: Cloud Run + Cloud SQL](#a-cloud-run-jobs-and-cloud-sql-infragcp-cloudrun) · [B: always-on VM](#b-always-on-vm-infragcp-vm) ·
[C: Kubernetes](#c-kubernetes-infragcp-and-infrak8s) · [D: local](#d-local) · [verify](#verify-a-deployment) ·
[update and roll back](#update-and-roll-back) · [cost knobs](#cost-knobs) · [security](#security) ·
[Azure broker](#azure-token-broker) · [derived runner images](#derived-runner-images-and-bootstrapd)

## Choose a path

| path | control plane runs on | sandboxes run in | state | pick it when |
|---|---|---|---|---|
| **A** `infra/gcp-cloudrun` | Cloud Run service | one Cloud Run job execution per task | Cloud SQL | you want no servers, can live with no path-level access control (see [Security](#security)) |
| **B** `infra/gcp-vm` | one Compute Engine VM (docker compose + Caddy HTTPS) | a warm runner on the VM, plus Cloud Run jobs for roles with `runtime: cloudrun` | Cloud SQL (via proxy) | you want chat to stay fast and cheap, HTTPS without a load balancer, and the ability to restrict routes |
| **C** `infra/gcp` + `infra/k8s` | a GKE pod | Kubernetes Jobs, one namespace per employee | Cloud SQL | you already run Kubernetes |
| **D** `infra/local` | your laptop | local processes (or kind) | Docker Postgres | trying it out |

**B depends on A.** The VM stack does not create the database, secrets, image registry or Cloud Run jobs. It reads the ones `infra/gcp-cloudrun`
created, by name. The layout the repo is built around is A applied once (control-plane service parked at zero instances) plus B as the live
control plane.

## Prerequisites

- A Google Cloud project with billing, and `gcloud` logged in (`gcloud auth login` and `gcloud auth application-default login`).
- Terraform 1.5 or newer. Docker or Cloud Build for images. Provider `hashicorp/google ~> 8.2`.
- For B: the Compute Engine API enabled (the VM stack does not enable it), the `default` VPC network, and IAP SSH access for the account that runs
  `apply.sh` (`roles/iap.tunnelResourceAccessor` and OS Login). IAP's tunnel needs a firewall rule allowing `35.235.240.0/20` to tcp:22. The `default`
  network normally has `default-allow-ssh`; if yours does not, set `ssh_source_ranges = ["35.235.240.0/20"]`.
- Credentials to give the employee: a model credential (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or `ANTHROPIC_API_KEY`), a ClickUp API token and
  team id, a GitHub token (`GH_TOKEN`; use a fine-grained token limited to the repos the roles clone, and protect your main branches so it cannot merge or push to them).
  Slack is optional.
- A `.env` at the repo root (copy `.env.example`). It is gitignored. The `apply.sh` scripts source it and turn values into `TF_VAR_*`.

Values and where they go:

| value | local | A (Cloud Run) | B (VM) | C (Kubernetes) |
|---|---|---|---|---|
| database URLs | `.env` | Secret Manager `database-url`, `dbos-system-database-url` (built by Terraform from `DB_PASSWORD`) | same secrets, rewritten at boot to the proxy address | `Secret` (`secret.example.yaml`) |
| `CLAUDE_CODE_OAUTH_TOKEN`, `CLICKUP_API_TOKEN`, `CLICKUP_WEBHOOK_SECRET`, `CLICKUP_CHAT_SECRET`, `GH_TOKEN` | `.env` | Secret Manager, seeded from `.env` at apply | same secrets, fetched on the VM at boot | `Secret` |
| `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN` | `.env` | Secret Manager | **not wired** on the VM (see B) | `Secret` |
| `ANTHROPIC_API_KEY` | `.env` | **not wired** (use the OAuth token) | **not wired** | `Secret` |
| `CLICKUP_TEAM_ID`, `ALERT_CHANNEL_ID`, `DEFAULT_EMPLOYEE_ID` | `.env` | Terraform `env` map (apply.sh) | Terraform `env` map (apply.sh) | `ConfigMap` |
| everything else (`PORT`, `SANDBOX_RUNTIME`, `PUBLIC_BASE_URL`, ...) | `.env` | computed by Terraform | computed by `startup.sh.tftpl` | `ConfigMap` |

The full variable list, with defaults, is `apps/control-plane/src/config.ts`, mirrored in `.env.example`.

## Build and push images

Three images, built from the repo root:

| image | Dockerfile | contents |
|---|---|---|
| `control-plane` | `apps/control-plane/Dockerfile` | the server and the roles directory (`/app/apps/control-plane/roles`) |
| `runner` | `apps/runner/Dockerfile` | Node 22, Claude Code, ClickUp MCP, git, gh, ripgrep, jq, `ai-employee-tools`, compound-engineering skills |
| `runner-ops` | `apps/runner/Dockerfile.ops` | `runner` plus the Azure CLI behind a read-only guard |

Build natively for amd64 with Cloud Build (Cloud Run does not run arm64, and this avoids cross-building on an Apple Silicon laptop). First enable the APIs and create the
registry (once; see the note after this block):

```sh
gcloud services enable cloudbuild.googleapis.com artifactregistry.googleapis.com --project my-gcp-project
REPO=us-central1-docker.pkg.dev/my-gcp-project/ai-employee
TAG=$(git rev-parse --short HEAD)

# all three images (build timeout 40 minutes, machine type E2_HIGHCPU_8)
gcloud builds submit --project my-gcp-project --config cloudbuild.yaml \
  --substitutions=_REPO=$REPO,_TAG=$TAG .

# only the control plane (after changing roles/, prompts or server code)
gcloud builds submit --project my-gcp-project --config cloudbuild.control-plane.yaml \
  --substitutions=_REPO=$REPO,_TAG=$TAG .
```

Both configs also push a `latest` tag. Use the unique `$TAG` for deploys: re-applying Terraform with an unchanged tag does nothing.

The registry is created by `infra/gcp-cloudrun` (`google_artifact_registry_repository.images`, id `ai-employee`), but Terraform needs image URLs before its first full
apply. Create the registry first with `terraform apply -target=google_artifact_registry_repository.images` and placeholder values for the required variables
(`-var control_plane_image=x -var runner_image=x -var runner_ops_image=x -var db_password=...`). Do not create it with `gcloud artifacts repositories create`
unless you then `terraform import` it. The repository keeps the last 10 versions per package and deletes untagged images after 3 days and anything after 30 days.

## A. Cloud Run jobs and Cloud SQL (`infra/gcp-cloudrun`)

Creates: the required APIs, the Artifact Registry repo, Cloud SQL Postgres 17 (`ai-employee-pg`, databases `ai_employee` and `ai_employee_dbos`, user `ai`),
Secret Manager secrets, service accounts, the control-plane Cloud Run service, and Cloud Run jobs `ai-employee-runner` and `ai-employee-runner-ops`.

```sh
cd infra/gcp-cloudrun && terraform init
# .env must contain GCP_PROJECT, DB_PASSWORD, CLICKUP_TEAM_ID and the secrets you have
./apply.sh "$TAG" "$TAG"       # control-plane tag, runner tag; extra args go to `terraform apply`
```

`apply.sh` sources `../../.env`, exports the secrets as `TF_VAR_*`, and sets `TF_VAR_env` to `DEFAULT_EMPLOYEE_ID=dev`, `CLICKUP_TEAM_ID`, `ROLES_DIR` and `LOG_LEVEL`. A secret left
empty is created as an empty shell; add the value later with
`echo -n "<value>" | gcloud secrets versions add <secret-id> --data-file=-`. Secret ids: `claude-code-oauth-token`, `clickup-api-token`, `clickup-webhook-secret`,
`clickup-chat-secret`, `gh-token`, `slack-signing-secret`, `slack-bot-token`, `azure-client-secret` (created but not passed to the container), `database-url`,
`dbos-system-database-url`.

Variables you may set (`variables.tf`):

| variable | default | meaning |
|---|---|---|
| `project_id`, `region`, `name` | required, `us-central1`, `ai-employee` | `name` prefixes every resource and is the `CLOUDRUN_JOB_PREFIX` |
| `db_tier`, `db_password` | `db-f1-micro`, required | Cloud SQL size and the `ai` user's password |
| `control_plane_image`, `runner_image`, `runner_ops_image` | required | full image URLs |
| `min_instances` | `0` | **0 parks the service.** Set `1` for a live control plane; `max_instance_count` is fixed at 1 |
| `public_base_url` | `""` | the `service_url` output, set on the second apply |
| `env` | `{}` | extra plain env vars; overrides computed ones |
| `extra_runner_images` | `{}` | more Cloud Run jobs from derived images, see [below](#derived-runner-images-and-bootstrapd) |
| `secret_shells` | `[]` | Secret Manager secrets created empty; add values with `gcloud secrets versions add` so they never enter state. `infra/gcp-vm` takes the same variable to grant the VM access |

After the first apply: `terraform output -raw service_url`, set `PUBLIC_BASE_URL_CLOUD` to it in `.env`, and run `apply.sh` again so runners know where to send events.
Migrations run when the service boots; there is no separate step.

**Using A alone (no VM).** The Terraform sets defaults for the "VM is live" layout, so change three things: pass `-var min_instances=1` (apply.sh forwards extra arguments); pass an `env` that includes
`TICK_ENABLED=true`, otherwise nothing fires schedules, monitors or the manager (`TICK_ENABLED` is `false` in the computed env); and remember every role then runs
as a Cloud Run job, including chat. `apply.sh` hard-codes its `TF_VAR_env`, so run `terraform apply -var 'env={...}'` directly or edit the script. A Cloud Run job's `cpu` and `memory`
come from `cloudrun.tf` (runner 4 vCPU/16Gi, runner-ops 4 vCPU/8Gi, ceiling 5400s), not from the role.

The Cloud Run service allows unauthenticated invocation (`allUsers`) because webhooks and runner callbacks cannot present Google credentials. That also exposes the
operator routes. See [Security](#security).

## B. Always-on VM (`infra/gcp-vm`)

One `e2-medium` Debian 12 VM with a static IP. Its startup script installs Docker and gcloud, fetches secrets, writes `/opt/ai-employee/.env` (mode 600),
`docker-compose.yml` and a `Caddyfile`, and runs `docker compose up -d`. Compose services:

| service | what |
|---|---|
| `cloudsql` | Cloud SQL Auth Proxy, authenticates as the VM's service account |
| `control-plane` | the control plane, `env_file: .env`, no published port |
| `runner` | the warm runner (`RUNNER_MODE=server`, `RUNNER_MAX_CONCURRENCY=4`), with volumes for `/workspace` and Claude session transcripts |
| `azbroker` | optional, only when `azbroker_image` is set |
| `caddy` | ports 80 and 443, automatic HTTPS for `<ip-with-dashes>.sslip.io`, reverse proxy to the control plane |

Steps:

```sh
# 1. A is applied; images are pushed (control-plane tag, and the runner-ops tag used for the warm runner)
# 2. .env has GCP_PROJECT, GCP_ACCOUNT, CLICKUP_TEAM_ID, ALERT_CHANNEL_ID (optional), AZURE_* and AZBROKER_IMAGE (optional)
cd infra/gcp-vm && terraform init
./apply.sh "$CP_TAG" "$RUNNER_TAG"
terraform output -raw public_url          # https://<vm-ip>.sslip.io, valid after the first boot finishes (a couple of minutes)
```

`apply.sh` generates `RUNNER_TOKEN` (and `AZURE_BROKER_SECRET`) into `.env` on first run, applies Terraform, then SSHes through IAP to re-run the startup script and prints container
status, and finally polls `/health`. Note: `TF_VAR_runner_image` is set to `runner-ops:<tag>`, so the warm runner is the ops image. The startup script sets, among others, `SANDBOX_RUNTIME=warm`,
`MANAGER_ROLE=manager`, `DBOS__VMID=vm`, `CLOUDRUN_JOB_PREFIX=<name>` and `ROLES_DIR=/app/apps/control-plane/roles`; `var.env` entries are appended.

Things to know:

- **`MANAGER_ROLE=manager` is on.** Every employee needs a role with that id (the shipped `dev.yaml` has one), or you get failing manager tasks.
  Its heartbeat also runs a model call about hourly (`MANAGER_HEARTBEAT_MIN=60`); `0` disables it.
- **Secrets fetched:** only the seven in `vm_secret_ids` (`database-url`, `dbos-system-database-url`, `claude-code-oauth-token`, `clickup-api-token`,
  `clickup-webhook-secret`, `clickup-chat-secret`, `gh-token`). Slack tokens, `ANTHROPIC_API_KEY` and `AZURE_CLIENT_*` are **not** fetched, so Slack triggers and the
  `anthropic` and `azure` grants do not work on this stack unless you extend `startup.sh.tftpl` and `vm_secret_ids`.
- **`.env` on the VM is regenerated** from Secret Manager, Terraform values and `var.env` on every boot and every `apply.sh`. Hand edits are lost.
- **Terraform embeds `RUNNER_TOKEN` and `AZURE_BROKER_SECRET` in the instance's startup-script metadata** and in the compose file on the VM, so anyone who can read the
  instance's metadata can read them.
- The VM's service account has `artifactregistry.reader`, `cloudsql.client`, `run.developer` (to start Cloud Run jobs), log and metric writer, and per-secret access to those seven secrets.
- A daily timer runs `docker system prune -af`.
- Logs go to Cloud Logging (`gcplogs` driver, label `service`). On the box: `gcloud compute ssh --zone us-central1-b ai-employee-vm --tunnel-through-iap`, then
  `sudo docker compose -f /opt/ai-employee/docker-compose.yml logs -f control-plane`.
- `infra/gcp-vm/README.md` contains a paragraph saying the runner has no server mode. That text is out of date: `RUNNER_MODE=server` is implemented in `apps/runner/src/server.ts`.

Change a secret on B: `echo -n "<new>" | gcloud secrets versions add clickup-api-token --data-file=-`, then on the VM `sudo google_metadata_script_runner startup`.

### Register the triggers

Use the HTTPS URL (`public_url` on B, `service_url` on A).

- **ClickUp comments and assignment.** Create a webhook with the ClickUp API for events `taskCommentPosted` and `taskAssigneeUpdated`, endpoint `<url>/clickup/webhook`. ClickUp returns a signing
  secret for the webhook; store it as `clickup-webhook-secret` and restart or re-run the startup script. (API call per ClickUp's webhook documentation, not exercised here.)
  ```sh
  curl -X POST "https://api.clickup.com/api/v2/team/$CLICKUP_TEAM_ID/webhook" \
    -H "Authorization: $CLICKUP_API_TOKEN" -H 'Content-Type: application/json' \
    -d '{"endpoint":"https://<vm-ip>.sslip.io/clickup/webhook","events":["taskCommentPosted","taskAssigneeUpdated"]}'
  ```
  Then comment `!dev` on a task (the word is `CLICKUP_TRIGGER_WORD`, default `!<DEFAULT_EMPLOYEE_ID>`).
- **ClickUp Chat.** In ClickUp, add an Automation on the channel: "Message is posted", action "Call webhook", URL `<url>/clickup/chat`, header `X-Bot-Secret: <CLICKUP_CHAT_SECRET>`.
  The query parameter `?X-Bot-Secret=...` is accepted too. If `CLICKUP_CHAT_SECRET` is empty the route rejects everything.
- **Slack** (A and C only). Events API request URL `<url>/slack/events`, subscribe to `app_mention` and `message` events, put the signing secret in `SLACK_SIGNING_SECRET` and the bot token in `SLACK_BOT_TOKEN`.
- **Plain HTTP.** `POST <url>/tasks`, see [Verify](#verify-a-deployment). Restrict it first.

## C. Kubernetes (`infra/gcp` and `infra/k8s`)

`infra/gcp` creates GKE Autopilot, Artifact Registry, Cloud SQL, service accounts with Workload Identity bindings, and empty Slack secret shells. `infra/k8s` holds plain manifests (namespace, RBAC,
Deployment, Service, Ingress with a managed certificate, runner service account). The control plane creates a namespace `ai-emp-<employee id>` and one Job per task. The full
command sequence is in `infra/gcp/README.md`. In outline:

```sh
cd infra/gcp && terraform init && terraform apply -var project_id=my-gcp-project -var db_password=... -var 'employee_ids=["dev"]'
gcloud container clusters get-credentials ai-employee --region us-central1 --project my-gcp-project
# build and push control-plane and runner (see above), then edit infra/k8s/*.yaml: REGION, PROJECT_ID, host names
kubectl apply -f infra/k8s/namespace.yaml -f infra/k8s/rbac.yaml
cp infra/k8s/configmap.example.yaml infra/k8s/configmap.yaml   # set PUBLIC_BASE_URL, RUNNER_IMAGE, DEFAULT_EMPLOYEE_ID
cp infra/k8s/secret.example.yaml infra/k8s/secret.yaml         # fill in; do not commit
kubectl apply -f infra/k8s/configmap.yaml -f infra/k8s/secret.yaml -f infra/k8s/deployment.yaml -f infra/k8s/service.yaml -f infra/k8s/ingress.yaml
```

Known gaps in the manifests, stated in their own comments:

- The Deployment has **no Cloud SQL proxy sidecar**, but Cloud SQL here is public IP with no authorized networks. Add the proxy sidecar (the `secret.example.yaml` URLs assume it on `127.0.0.1:5432`) or point the URLs at a reachable Postgres.
- `secret.example.yaml` lists only Slack and Anthropic values. Add `CLAUDE_CODE_OAUTH_TOKEN`, `CLICKUP_*`, `GH_TOKEN` as your roles need.
- `runner-serviceaccount.yaml` has no effect yet: the control plane builds `KubernetesJobRuntime` without a `serviceAccountName`, so runner pods do not use it. Use `ANTHROPIC_API_KEY` or the OAuth token, not Workload Identity, for the runner.
- Job pods receive credentials as plain env values in the pod spec. Anyone who can read pods or Jobs in the employee namespace can read them.
- Roles with `runtime: cloudrun` fall back to Kubernetes here (Cloud Run is not registered). Set `GCP_PROJECT` and create jobs if you want that tier.
- The Ingress uses GKE's ingress class and a `ManagedCertificate` for the host in `ingress.yaml`; point DNS at the Ingress IP.

## D. Local

See the Quickstart in the [README](../README.md#quickstart-local). `make dev` starts Postgres; `make kind` creates a kind cluster for the Kubernetes runtime.

## Verify a deployment

Run these against your URL (`$URL`). On A, `/health` is the right path: Google's front end answers paths ending in `z` (such as `/healthz`) with its own 404.

```sh
curl -s $URL/health                       # {"ok":true}
curl -s $URL/runtime                      # warm runner capacity and runs (warm.error if unreachable), active and recent tasks
curl -s $URL/employees/dev/monitors       # confirms the YAML loaded; all monitors enabled:false
open $URL/status                          # live page (also: $URL/runs/<task id>/view)

# smoke task: read-only role, no repos, no delegation
curl -s $URL/tasks -H 'content-type: application/json' \
  -d '{"employeeId":"dev","roleId":"assistant","prompt":"Say hello and list your tools.","taskKey":"smoke1"}'
curl -s $URL/tasks/http:dev:smoke1        # status: queued, running, then done; result.text, result.costUsd
curl -s $URL/tasks/http:dev:smoke1/events # what the agent did
```

Sending the same `taskKey` again returns `200 {"started":false}`. A `failed` task with `exit.code` 1 and an empty events list means the runner died before Claude Code started; read the control-plane and runner logs
(for example a missing `/workspace` on a local run, or a bad image). A ClickUp round trip: comment `!dev what repos can you see?` on a task; you should get a robot-prefixed placeholder that is edited into the answer.

## Update and roll back

| change | do this |
|---|---|
| new code, role YAML or prompt | build the control-plane image with a new tag, then A: `./apply.sh <cp-tag> <runner-tag>`; B: the same in `infra/gcp-vm` (updates metadata, re-runs the startup script, restarts only changed containers); C: `kubectl set image` or edit `deployment.yaml` |
| runner tools or Claude Code version | build `runner` and `runner-ops`, apply with the new runner tag. On B this recreates the runner container and kills runs inside it, so check `GET /runtime` first |
| a secret | add a Secret Manager version, then restart (A: new revision, `apply.sh`; B: `google_metadata_script_runner startup`) |
| env value | A and B: Terraform `env` variable; C: ConfigMap, then restart |
| monitors on/off, schedules | no deployment, see [configuration](configuration.md#how-to) |

**Roll back** by applying the previous tags (`./apply.sh <old-cp-tag> <old-runner-tag>`); images stay in the registry (the last 10 versions per package are kept). Database migrations are forward-only SQL
files applied at boot (`apps/control-plane/migrations`), so a rollback does not undo them; they are additive so far. Cutting over from A to B or back only moves two webhook URLs and the Cloud Run scaling flag
(`gcloud run services update ai-employee-control-plane --region us-central1 --min-instances=0|1`); `infra/gcp-vm/README.md` has the sequence. Run exactly one control plane that ticks
(`TICK_ENABLED=true`); the parked one must have `TICK_ENABLED=false` and its own `DBOS__VMID` so it never recovers the other's workflows. Both are the defaults in these stacks.

## Cost knobs

| knob | where | effect |
|---|---|---|
| `maxTurns`, `timeoutSec` | each role | caps tokens and time per run; a run that hits the cap ends and reports it |
| `model` | each role | use a cheaper model (`sonnet`) for triage-style roles |
| monitors | enable only what you need | collection is free; model cost only when a finding appears |
| `MANAGER_HEARTBEAT_MIN` | env | `0` stops the hourly idle manager run; `MANAGER_DEBOUNCE_SEC` batches wakes |
| `RUNNER_MAX_CONCURRENCY` | `startup.sh.tftpl` (default 4) | parallel runs on the warm runner |
| `machine_type`, `disk_gb` | gcp-vm variables | `e2-medium` is roughly $25 a month always on |
| `min_instances`, `db_tier` | gcp-cloudrun variables | a live Cloud Run control plane is roughly $15 to $25 a month; `db-f1-micro` roughly $10 |
| Cloud Run job cpu, memory | `cloudrun.tf`, `extra_runner_images` | jobs bill only while running |
| schedules | agent-created | 15 minute minimum interval, 20 enabled per employee |

Use `GET /stats?since=7d` (or `/employees/:id/stats`) for token and cost totals, and set `ALERT_CHANNEL_ID` for a daily digest.

## Security

The control plane trusts its network. **Most routes have no authentication.** Check this table against `apps/control-plane/src/http/server.ts` before you deploy.

**No authentication (anyone who can reach the port):**

| route | what it exposes |
|---|---|
| `POST /tasks` | starts a task for any employee and role with any prompt, using that role's credentials |
| `GET /tasks/:id`, `GET /tasks/:id/events` | the full task record, prompt, result and every tool call and output |
| `POST /tasks/:id/cancel` | cancels any running task |
| `GET /employees/:id/tasks`, `/employees/:id/stats`, `/employees/:id/monitors`, `/employees/:id/schedules`, `GET /stats` | task history, cost, monitor and schedule configuration |
| `GET /runtime`, `GET /status`, `GET /runs/:id/view` | live view of runs, the warm runner's state, recent failures |
| `GET /health`, `GET /healthz` | liveness only (harmless) |

**Signed or shared-secret (safe to expose):**

| route | check |
|---|---|
| `POST /slack/events` | Slack HMAC signature, 5-minute replay window, fails closed if `SLACK_SIGNING_SECRET` is empty |
| `POST /clickup/webhook` | ClickUp `X-Signature` HMAC-SHA256 of the raw body with `CLICKUP_WEBHOOK_SECRET`, fails closed if empty |
| `POST /clickup/chat` | `X-Bot-Secret` header (or query parameter) equal to `CLICKUP_CHAT_SECRET`, rejects if unset |

**Per-run bearer token (called by sandboxes; all but `POST /runs/:id/events` also send `X-Task-Id`):** `POST /runs/:id/events`, `GET|POST /agents`, `GET /agents/:id`, `POST /agents/:id/cancel`, `GET /agents/:id/events`, `POST /agents/self/ask`,
`GET /agents/self/answer`, `GET|POST|DELETE /schedules`, `GET /monitors`, `POST /monitors/:name/:action`, `GET /tasks/recent`. The token is random, stored hashed, tied to one task and valid for the role's `timeoutSec`
plus 10 minutes. Capability checks (`agents`, `schedules`, `monitors`, `backlog`, `canSpawn`, `canSchedule`) apply on top.

These must stay reachable from wherever sandboxes run. Cloud Run jobs call back over the public URL from Google addresses you cannot allowlist, so the token-protected routes stay on the public internet.

### Restrict the open routes before you expose the host

There is no built-in API token. Options, strongest first:

1. **Do not expose them.** Put the whole service on a private network or VPN and let only the webhook senders in (not possible for ClickUp or Slack, which call from the internet).
2. **Proxy rules (works on B).** Block the operator routes at Caddy unless the caller is yours. Edit the `Caddyfile` heredoc in `infra/gcp-vm/startup.sh.tftpl` and re-apply. This block was
   validated with Caddy 2 and returns 403 for `/tasks`, `/tasks/:id`, `/tasks/:id/events`, `/employees/*`, `/stats`, `/runtime`, `/status` and `/runs/:id/view`, and passes `/health`, `/tasks/recent`, `/runs/:id/events`,
   `/agents*`, `/schedules`, and the three webhook routes:

   ```caddy
   <vm-ip>.sslip.io {            # in startup.sh.tftpl this line is ${host}; keep it
   	@operator {
   		path /tasks /tasks/* /employees/* /stats /runtime /status /runs/*/view
   		not path /tasks/recent
   		not remote_ip 203.0.113.7/32      # your office or VPN address
   	}
   	respond @operator 403
   	reverse_proxy control-plane:3000
   }
   ```

   From outside that address, drive tasks through ClickUp or Slack, or over an SSH/IAP tunnel to the VM and `curl` the compose network.
3. **IAP or a load balancer with Cloud Armor** in front of A or C, with the webhook and sandbox callback paths excluded. Not shipped; A exposes the service to `allUsers` and has no path-level control.
4. **Code change:** add an API token check to the open routes in `server.ts`.

Other points:

- The events API returns everything the agent saw, including file contents and command output. Treat it as sensitive.
- The sandbox has unrestricted outbound network and runs with the credentials of its grants. Scope tokens (fine-grained GitHub token, read-only ClickUp mode in role MCP config, branch protection) rather than trusting the prompt.
- Secrets: keep `.env`, `*.tfstate` and `*.tfvars` out of git (the repo ignores them). Terraform state here is local by default and contains secret values (Secret Manager versions, the DB password). Use an encrypted remote backend for anything shared.
- Credentials are passed to sandboxes as environment variables: Cloud Run execution overrides, Kubernetes pod specs, the warm runner's request body. People with read access to those resources can read them.
- Anything pushed to a public repo is scanned by `scripts/leak-check.mjs` (denylist plus blocked file types) and gitleaks in CI. Add your own private terms in `~/.config/ai-employee/leak-denylist.txt` or `LEAK_DENYLIST`.

## Azure token broker

`infra/azbroker` is a small container (Azure CLI image plus a stdlib Python HTTP server, `server.py`) that holds **one human's `az login`** and serves tokens over Azure's App Service managed-identity protocol.
Runners (`azure-user` grant) run `az login --identity` against it, and the `azure-errors` monitor asks it for tokens. Tokens carry that person's permissions; the refresh token never leaves the broker container. A shared
secret (`AZURE_BROKER_SECRET`, sent as `X-IDENTITY-HEADER`) protects it, and it publishes no port outside the compose network.

Use it when agents should read Azure with an existing person's rights and you do not want to create a service principal. If you can create a service principal, the `azure` grant with
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET` and `AZURE_SUBSCRIPTION_ID` is simpler and does not depend on a person's login. The broker only works where the runner can reach it: on B, the warm runner
(compose network). Cloud Run jobs cannot reach it, which is why `dev.yaml` leaves `azure-user` off its Cloud Run roles.

```sh
gcloud builds submit --project my-gcp-project --config infra/azbroker/cloudbuild.yaml \
  --substitutions=_REPO=$REPO,_TAG=1 infra/azbroker
# .env: AZBROKER_IMAGE=$REPO/azbroker:1, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID   (apply.sh adds AZURE_BROKER_SECRET)
cd infra/gcp-vm && ./apply.sh "$CP_TAG" "$RUNNER_TAG"
# once, on the VM: log in as the person whose rights the agent should have
sudo docker compose -f /opt/ai-employee/docker-compose.yml exec azbroker az login --use-device-code
sudo docker compose -f /opt/ai-employee/docker-compose.yml exec azbroker az account show   # confirms the login
```

The broker's login state lives in the `azbroker_azure` volume and survives restarts. The runner image's `az` is wrapped by `az-readonly.sh`, which refuses mutating verbs unless `AZ_READONLY=0`.

## Derived runner images and `bootstrap.d`

Add tools, logins or skills by building your own image `FROM` the runner. Before the agent starts, the runner runs every executable file in `/etc/ai-employee/bootstrap.d/` (override the directory
with `BOOTSTRAP_D_DIR`) in name order, each with a 60 second timeout and the run's environment. The last line of each script's stdout is logged as a note. A failing script does not stop the run.

```dockerfile
FROM us-central1-docker.pkg.dev/my-gcp-project/ai-employee/runner:TAG
USER 0
RUN apt-get update && apt-get install -y --no-install-recommends my-tool && rm -rf /var/lib/apt/lists/*
COPY 10-login.sh /etc/ai-employee/bootstrap.d/10-login.sh
RUN chmod 755 /etc/ai-employee/bootstrap.d/10-login.sh
USER 1000:1000
```

`apps/runner/Dockerfile.ops` is the worked example (it adds the Azure CLI on top of `runner`).

Use the image in a role with `image: <registry>/runner-custom:TAG`. What happens next depends on the runtime:

- **Cloud Run:** each image needs its own pre-created job, named `<name>-<basename>`. Add it with `extra_runner_images` in `infra/gcp-cloudrun`; the map key must equal the image's repository basename.
  `extra_runner_images` is also how you get more than the default cpu, memory and timeout (a role's `timeoutSec` is capped by its job):
  ```hcl
  extra_runner_images = {
    runner-custom = { image = "us-central1-docker.pkg.dev/my-gcp-project/ai-employee/runner-custom:TAG", cpu = "8", memory = "16Gi", timeout = "14400s" }
  }
  ```
- **Kubernetes:** the role's `image` is the pod image directly.
- **Warm runner and local:** `image` is ignored. The warm runner runs whatever image the `runner` container was started with, so to change its tools, point `runner_image` at your derived image.

## Derived control-plane image (private config on the public engine)

Keep your employees, roles and prompts in your own repository and build the control-plane image `FROM` the engine image:

```dockerfile
ARG ENGINE
FROM ${ENGINE}                                  # the engine's control-plane image, pinned by tag
COPY --chown=node:node employees   /config/employees
COPY --chown=node:node roles       /config/roles
COPY --chown=node:node prompts     /config/prompts
ENV CONFIG_DIRS=/config,/app/presets
```

`CONFIG_DIRS` wins over a `ROLES_DIR` left in the environment by the Terraform stacks, so no stack change is needed. The `--chown` matters: the image runs as `node`.
Roles that name `imageRef: <key>` need `RUNNER_IMAGES` (a JSON object of key to image) in the control plane's environment (`var.env`).
