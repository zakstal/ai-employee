# ai-employee

An AI developer deployed on the cloud. Triggered by Slack / HTTP (ClickUp, Azure, GitHub, cron later),
runs Claude Code in an isolated sandbox per task, streams what it did back, replies where it was asked.

One durable **Employee** identity shared by every conversation. Same trigger cannot fire twice.
Roles are config, not model judgment. The control plane never runs agent code.

```
Slack / HTTP ──▶ control-plane (Fastify + DBOS on Postgres)
                    │  startTask(taskId)  ← taskId is the dedup key
                    ▼
               taskWorkflow  (durable: survives restarts)
                    │ launchSandbox ──▶ SandboxRuntime adapter ──▶ k8s Job | local process | (Namespace, Cloud Run)
                    │ waitForExit                                       │ runner container: Claude Code -p
                    │ collectResult  ◀── POST /runs/:id/events  ◀───────┘ normalized RunnerEvents
                    │ postResult ──▶ Slack thread
                    ▼ finalize ──▶ ledger (tasks, task_events)
```

## Layout

| path | what |
|---|---|
| `packages/core` | the two adapter boundaries (`Orchestrator`, `SandboxRuntime`), `RunnerEvent`, `Role`/`Employee` schemas |
| `packages/adapters` | `LocalProcessRuntime` (tests/dev), `KubernetesJobRuntime` |
| `apps/control-plane` | Fastify HTTP (Slack ingress, event sink, task API), DBOS workflow + steps, ledger SQL, role loader |
| `apps/runner` | container image: spawns `claude -p --output-format stream-json`, translates to `RunnerEvent`, pushes to sink |
| `apps/control-plane/roles/*.yaml` | employees and their roles (deterministic capability config) |
| `infra/local` | docker-compose Postgres, kind config |
| `infra/gcp`, `infra/k8s` | Terraform (GKE Autopilot, Cloud SQL, WI) and plain manifests |

## Run locally

```sh
make dev            # Postgres on :5432 (dbs: ai_employee, ai_employee_dbos)
pnpm install && pnpm -r build
cp .env.example .env   # fill ANTHROPIC_API_KEY; leave Slack blank for now
pnpm --filter @ai-employee/control-plane migrate
SANDBOX_RUNTIME=local LOCAL_RUNNER_CMD="node ../runner/dist/index.js" pnpm --filter @ai-employee/control-plane dev
```

Trigger a task without Slack:

```sh
curl -s localhost:3000/tasks -H 'content-type: application/json' \
  -d '{"employeeId":"dev","prompt":"List the files in your working directory and summarise them.","taskKey":"demo1"}'
curl -s localhost:3000/tasks/http:dev:demo1 ; curl -s localhost:3000/tasks/http:dev:demo1/events
```

Send the same `taskKey` again → `200 {"started":false}`. That is the dedup guarantee.

### Kubernetes on the laptop

```sh
make kind
docker build -f apps/runner/Dockerfile -t ai-employee-runner:dev . && kind load docker-image ai-employee-runner:dev --name ai-employee
# control plane on the host talks to kind via ~/.kube/config; runner pods reach it via host.docker.internal
PUBLIC_BASE_URL=http://host.docker.internal:3000 SANDBOX_RUNTIME=k8s pnpm --filter @ai-employee/control-plane dev
```

## Health

`GET /health` (and `/healthz`). Use `/health` against Cloud Run URLs: Google's edge reserves paths ending in `z` and answers them with its own 404 before your container sees them.

## Triggers

| channel | how | dedup key |
|---|---|---|
| ClickUp task comment | comment containing `!dev` (configurable `CLICKUP_TRIGGER_WORD`; `@` collides with ClickUp's mention picker) | `clickup:<task>:comment:<comment id>` |
| ClickUp task assigned to the bot user | needs `CLICKUP_BOT_USER_ID` | `clickup:<task>:assigned:<history id>` |
| ClickUp Chat channel | Chat Automation "Message is posted" → "Call webhook" to `/clickup/chat` with header `X-Bot-Secret` | `clickup-chat:<channel>:<message id>` |
| Slack mention / message | Events API → `/slack/events` | `slack:<team>:<channel>:<ts>` |
| HTTP | `POST /tasks` with optional `taskKey` | `http:<employee>:<key>` |

Bot replies start with 🤖 and are ignored on the way back in, so the bot cannot trigger itself.

## Tests

```sh
pnpm -r test                                                   # unit + DBOS end-to-end (needs `make dev`)
cd packages/adapters && K8S_INT=1 pnpm vitest run src/k8s-job.int.test.ts   # needs `make kind`
```

## Rules that keep the adapters cheap to swap

- Workflow body (`apps/control-plane/src/orchestration/workflow.ts`) only sequences steps. No clock, no IO, no env.
  Written under Temporal's determinism rules even though DBOS does not require them.
- Runner **pushes** events; adapters never tail logs.
- Credentials are injected per run via env. Workload Identity is a k8s-only shortcut, not a dependency.
- Sub-agents will be child tasks through the control plane, not Claude Code in-process subagents.
