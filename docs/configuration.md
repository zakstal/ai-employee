# Configuration: employee YAML

An **employee** is one YAML file in the roles directory (`ROLES_DIR`, default `roles` relative to the control
plane's working directory; `/app/apps/control-plane/roles` in the images). The control plane reads every
`*.yaml` / `*.yml` file in that directory (not subdirectories) once at boot, validates it with the schema in
`packages/core/src/role.ts`, and refuses to start if any file is invalid or two files share an `id`.

The example in the repo is `apps/control-plane/roles/dev.yaml`. This page explains every field, then how to change things and what
you must redeploy afterwards.

Contents: [minimal example](#minimal-example) · [employee](#employee) · [roles](#roles) ·
[prompts](#prompts) · [tools and capabilities](#tools-and-capabilities) · [credentials](#credentials) ·
[runtimes](#runtimes-image-and-limits) · [repos](#repos) · [workstreams](#workstreams) · [monitors](#monitors) ·
[schedules](#schedules) · [manager](#manager-and-backlogs) · [dev.yaml explained](#devyaml-explained) ·
[how to](#how-to) · [what to redeploy](#what-to-redeploy)

## Minimal example

Save as `roles/helper.yaml` (or replace `dev.yaml`). It is valid as written.

```yaml
id: dev                      # unique across files; used in task ids (http:dev:...) and as DEFAULT_EMPLOYEE_ID
name: Dev Bot                # display name
defaultRole: assistant       # role for Slack, ClickUp and POST /tasks without roleId
roles:
  - id: assistant
    description: Read-only engineering helper.
    systemPrompt: |          # appended to Claude Code's own system prompt
      You are Dev Bot. Be concise. Your final message is posted as the reply in the
      channel the request came from, so write it as that reply.
    allowedTools: [Read, Grep, Glob, "Bash(git log *)"]   # everything else is denied, never prompted
    maxTurns: 25
    timeoutSec: 900
    credentials: [anthropic]                 # which env secrets this run receives (see Credentials)
    repos:
      - url: https://github.com/your-org/your-repo.git   # cloned into /workspace/your-repo
        ref: main
```

Unknown keys are silently dropped (the schema is not strict), so a typo in a field name does nothing. Check the boot log, which prints the
loaded employee ids.

## Employee

| field | type | required | meaning |
|---|---|---|---|
| `id` | string | yes | Unique id. Appears in task ids, in the Kubernetes namespace (`ai-emp-<id>`), and in API paths (`/employees/:id/...`). |
| `name` | string | yes | Display name. |
| `defaultRole` | string | yes | Role used when a trigger names none: Slack, ClickUp, `POST /tasks` without `roleId`. Not checked at boot; a wrong id fails the first task. |
| `roles` | list | yes (at least 1) | See [Roles](#roles). |
| `workstreams` | map | no | See [Workstreams](#workstreams). |
| `monitors` | map | no | See [Monitors](#monitors). |

## Roles

A role is a lookup entry: the same trigger and role always produce the same sandbox configuration.

| field | default | meaning |
|---|---|---|
| `id` | required | Role id, unique within the employee. |
| `description` | `""` | Free text for humans. |
| `systemPrompt` | `""` | Inline system prompt. |
| `systemPromptFile` | none | Path relative to the roles directory. Its contents replace `systemPrompt`. Must stay inside the roles directory. |
| `allowedTools` | `[]` | Claude Code tool allowlist, e.g. `Read`, `Edit`, `"Bash(git *)"`, `"mcp__clickup__*"`. |
| `disallowedTools` | `[]` | Claude Code deny list. |
| `mcpServers` | `{}` | Extra MCP servers, in Claude Code's `--mcp-config` shape. |
| `model` | Claude Code default | Model id or alias passed as `--model`, e.g. `sonnet`. |
| `maxTurns` | `50` | Passed as `--max-turns`. A run that hits it ends with a "turn limit" message. |
| `runtime` | `k8s` | `k8s` means "the deployment's default runtime". `cloudrun` opts this role into Cloud Run jobs. See [Runtimes](#runtimes-image-and-limits). |
| `image` | `RUNNER_IMAGE` | Runner image for this role. |
| `cpu` | `1` | vCPU request. Not honoured on Cloud Run. |
| `memoryMb` | `2048` | Memory in MiB. Not honoured on Cloud Run. |
| `timeoutSec` | `1800` | Hard time limit for one run. Also sets the run token lifetime (this plus 10 minutes). |
| `credentials` | `[]` | Credential grants. See [Credentials](#credentials). |
| `repos` | `[]` | Repositories cloned before the agent starts. See [Repos](#repos). |
| `capabilities` | `[]` | Extra control-plane powers: `agents`, `schedules`, `monitors`, `backlog`. See [Tools and capabilities](#tools-and-capabilities). |
| `canSchedule` | `[]` | Role ids this role may create schedules for, besides itself. |
| `canSpawn` | `[]` | Role ids this role may start as child agents. |

## Prompts

The final system prompt for a run is built in `apps/control-plane/src/orchestration/steps.ts`:

1. The role's prompt text: the contents of `systemPromptFile` if set, otherwise `systemPrompt`.
2. A blank line.
3. A generated footer, **"Your environment (authoritative ...)"**, derived from the role: which of `az`, `gh`/`git`, ClickUp tools
   are available (from `credentials`), the repos cloned under `/workspace`, the delegation, schedule, monitor and backlog tools
   (from `capabilities`), the allowed shell commands, and a line telling the model to test before claiming a tool is missing.

The result goes to Claude Code as `--append-system-prompt`, so Claude Code's own system prompt stays in place and yours is added to it.

The task prompt (what the user asked) is separate. For a ClickUp comment it is prefixed with the task's name, URL, status and
description. For a ClickUp chat message it is prefixed with the last `CLICKUP_CHAT_HISTORY` messages of the channel (default 20),
unless an earlier Claude Code session for the conversation is resumed. Other channels send the text as is.

Prompt files live under the roles directory (the example uses `roles/prompts/*.md`). The repo ships these for `dev.yaml`:

| file | role it drives |
|---|---|
| `foreman.md` | `developer`, `schema-lead`: answers simple questions; for real work delegates to stage roles and never merges |
| `triage.md`, `spec.md`, `implement.md`, `review.md` | stage roles of the `sdlc` workstream |
| `compound.md` | `compound`: runs one brief through the compound-engineering `lfg` pipeline and ends with an open PR |
| `manager.md` | `manager`: reads the backlog, checks the repo for what is done, dispatches what is unblocked |
| `monitor-triage.md` | `monitor-triage`: answers `NOISE`, posts an alert, or escalates to `developer` or `compound` |

A reply that is exactly `NOISE` (or `IDLE` for the manager) from a quiet, machine-triggered run is not posted anywhere.

## Tools and capabilities

`allowedTools` is the whole permission model inside the sandbox. The runner starts Claude Code in default permission mode with
`--permission-prompts none`, so anything not allowed is denied. Shell access is per command pattern: `"Bash(git *)"` allows git and
nothing else. MCP tools are allowed by name pattern: `"mcp__clickup__*"`.

`capabilities` adds a built-in MCP server named `ai_employee` (command `ai-employee-tools`, shipped in the runner image). It is
attached when the role lists any of `schedules`, `agents`, `monitors` or `backlog`, and `mcp__ai_employee__*` is added to the allowlist
automatically. The server calls back to the control plane with a per-run token. The server lists all its tools to any such role; the
control plane decides on each call.

| capability | tools | enforced by the control plane |
|---|---|---|
| `agents` | `spawn_agent(role, brief)`, `start_workstream(workstream, brief)`, `wait_for`, `agent_events`, `cancel_agent`, `list_agents`, `ask_human` | spawning needs `agents` and the target in `canSpawn`; at most 2 levels deep and 4 active children per task |
| `schedules` | `create_schedule`, `list_schedules`, `delete_schedule` | creating needs `schedules`; target role must be the caller or in `canSchedule` |
| `monitors` | `list_monitors`, `enable_monitor`, `disable_monitor` | all three need `monitors` |
| `backlog` | `list_tasks` (every recent task for the employee) | needs `backlog` |

`ask_human(question)` posts the question to the ClickUp task or chat channel the work started in and pauses the task until someone replies
there. It only works on the server, so **a role that never gets the `ai_employee` server cannot call it**. In `dev.yaml` the stage roles
(`triage`, `spec`, `implement`, `review`) have no `capabilities`, so their prompts mention `ask_human` but the tool is not attached. Give
a stage role `capabilities: [agents]` (and an empty `canSpawn`) if it should be able to ask. Answers are only routed back from ClickUp
(task comment or chat); a task started over HTTP records the question but has no way to receive an answer, and a Slack-started task cannot post the question at all.

`mcpServers` entries use Claude Code's shape. Placeholders such as `${CLICKUP_API_TOKEN}` are filled from the run's environment, which
comes from the role's `credentials`. A server whose placeholders cannot be resolved is dropped for that run, so a missing token does not
cost a 30-second MCP start timeout.

```yaml
mcpServers:
  clickup:
    command: clickup-mcp          # preinstalled in the runner image
    env:
      CLICKUP_API_KEY: "${CLICKUP_API_TOKEN}"
      CLICKUP_TEAM_ID: "${CLICKUP_TEAM_ID}"
      CLICKUP_MCP_MODE: read      # read-minimal | read | write
```

## Credentials

A grant copies named values from the control plane's own environment into the run's environment. Empty values are skipped. An unknown
grant name fails the task before launch (`unknown credential grant "..."`). A role with no model grant (`anthropic`,
`claude-subscription` or `vertex`) has no way to authenticate Claude Code.

| grant | env vars injected into the run | source and effect |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | Anthropic API key (pay per token) |
| `claude-subscription` | `CLAUDE_CODE_OAUTH_TOKEN` | from `claude setup-token`; uses your subscription's usage limits |
| `clickup` | `CLICKUP_API_TOKEN`, `CLICKUP_TEAM_ID` | ClickUp MCP server and API |
| `github` | `GH_TOKEN` and `NPM_GITHUB_TOKEN` (same value) | the runner points git's credential helper at `gh`, so clones and PRs work; the npm variable lets repos with private `@scope` packages install |
| `azure` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SUBSCRIPTION_ID` | the runner runs `az login --service-principal` when the first three are set |
| `azure-user` | `IDENTITY_ENDPOINT`, `IDENTITY_HEADER`, `MSI_ENDPOINT`, `MSI_SECRET`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | only when `AZURE_BROKER_URL` and `AZURE_BROKER_SECRET` are both set; the runner runs `az login --identity` against the [token broker](deploy.md#azure-token-broker) |
| `vertex` | `CLAUDE_CODE_USE_VERTEX=1`, plus `ANTHROPIC_VERTEX_PROJECT_ID` and `CLOUD_ML_REGION` if set in the control plane's environment | Claude on Vertex AI |

Every run also gets `TASK_ID`, `TASK_PROMPT`, `SYSTEM_PROMPT`, `ALLOWED_TOOLS`, `DISALLOWED_TOOLS`, `MAX_TURNS`, `MCP_CONFIG`,
`EVENT_SINK_URL`, `RUN_TOKEN`, and when set `MODEL`, `REPOS`, `WORKSPACE_KEY`, `RESUME_SESSION_ID`.

Grants are static. A secret reaches every role that names the grant, for the whole run. Give each role the narrowest list that works.
The `az` command in the `ops` runner image is wrapped by a read-only guard (`apps/runner/az-readonly.sh`; set `AZ_READONLY=0` to
disable it).

## Runtimes, image and limits

`SANDBOX_RUNTIME` picks the deployment default: `warm`, `cloudrun`, `k8s` or `local`. A role can override it only with
`runtime: cloudrun`, and only if the deployment registered Cloud Run (`SANDBOX_RUNTIME=cloudrun`, or `warm` with `GCP_PROJECT` set).
Any other value, or `cloudrun` on a deployment without it, falls back to the deployment default. The schema also accepts `fake` and
`namespace`; nothing registers them.

| runtime | where the run executes | `image` | `cpu`, `memoryMb`, `timeoutSec` |
|---|---|---|---|
| `warm` | a child process in the always-on runner container | ignored: the runner container's own image | `timeoutSec` honoured; cpu and memory are the container's |
| `cloudrun` | one execution of a pre-created Cloud Run job | its basename picks the job (`runner-ops:tag` runs job `<prefix>-runner-ops`; default `RUNNER_IMAGE`) | only `timeoutSec` applies, capped by the job's own ceiling. cpu and memory come from the job in `infra/gcp-cloudrun` |
| `k8s` | a Kubernetes Job in namespace `ai-emp-<employee id>` | the pod image | all honoured; `activeDeadlineSeconds` = `timeoutSec` |
| `local` | a child process of the control plane | ignored | `timeoutSec` honoured |

Build a derived image with extra tools by starting `FROM` the runner image; see
[docs/deploy.md](deploy.md#derived-runner-images-and-bootstrapd).

## Repos

```yaml
repos:
  - url: https://github.com/your-org/app.git   # required, must be a valid URL
    ref: main                                   # optional branch or tag (git clone --branch)
    path: app                                   # optional directory name under /workspace
```

The runner clones each repo into `/workspace/<path or repo name>` with `--depth 50`. If the directory already exists (a persistent
per-conversation workspace on the warm runner) it runs `git pull --ff-only` instead. A clone or pull failure is logged and the
run continues. Private repos need the `github` grant.

## Workstreams

```yaml
workstreams:
  sdlc:
    entryRole: developer
    description: "triage, spec, implement, review"
```

A workstream is a name for a starting role. `start_workstream("sdlc", brief)` (or `POST /agents {"workstream":"sdlc",...}`) starts a
child task running `entryRole`, subject to the caller's `canSpawn`. The stages themselves are not declared here: they are the entry
role's prompt (the procedure in `foreman.md`) plus its `canSpawn` list. To add a stage, add a role and list it in the coordinating
role's `canSpawn`; to reorder stages, edit the prompt.

## Monitors

```yaml
monitors:
  azure-errors:                  # name; used by enable_monitor / disable_monitor
    collector: azure-errors      # azure-errors | clickup-channels
    everyMin: 5                  # 1 to 1440, default 5
    role: monitor-triage         # role that receives new findings
    description: "..."
    config: { ... }              # collector-specific, below
```

A monitor runs on the control plane's one-minute tick while it is enabled. It collects with plain code (no model). If there are new
findings it starts one task for `role` with the findings and their evidence (source, window, counts, link, query). That task is
quiet: no placeholder message, and a `NOISE` reply is dropped. Its output goes to the ClickUp chat channel `ALERT_CHANNEL_ID`; if that is
unset the result is only stored in the ledger (visible at `/status`).

**Monitors are off by default.** The YAML defines them; whether one runs is a row in the `monitors` table. A collector that fails twice in
a row produces a finding about itself; one failure is ignored. The first run only records a baseline.

### Collector `azure-errors`

Queries Application Insights for exceptions and HTTP 5xx and, optionally, Azure Monitor alerts. Needs `AZURE_SUBSCRIPTION_ID` and either
the token broker (`AZURE_BROKER_URL`, `AZURE_BROKER_SECRET`) or a service principal (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
`AZURE_CLIENT_SECRET`).

| `config` key | default | meaning |
|---|---|---|
| `apps` | `[]` | list of `{ rg, name }`: resource group and Application Insights component name |
| `lookbackMin` | `15` | window to query |
| `minCount` | `5` | a known signature is a SPIKE only with at least this many in the window ... |
| `spikeFactor` | `3` | ... and at least this multiple of its 24-hour peak |
| `minNew` | `3` | a never-seen signature is reported as NEW only at this count or more |
| `alerts` | `true` | also report new Azure Monitor alerts (`false` to skip) |
| `alertCooldownMin` | `360` | the same alert rule on the same target is reported at most this often |

### Collector `clickup-channels`

Reports new human messages in ClickUp chat channels. Needs `CLICKUP_API_TOKEN` and `CLICKUP_TEAM_ID`. The first run only sets cursors.

| `config` key | default | meaning |
|---|---|---|
| `channels` | `[]` | list of `{ id, name }`: channel id (from the Chat view URL) and a label |
| `limit` | `25` | messages fetched per channel per run |

Messages that start with the bot marker (the robot emoji) are skipped.

## Schedules

Schedules are **not** declared in YAML. An agent creates them at run time and they are stored in the `schedules` table:

- A role with `capabilities: [schedules]` calls `create_schedule(name, cron, prompt, role?, timezone?)`. In practice you ask in chat:
  "every weekday at 07:00 summarise open PRs here".
- `name` is a slug (`[a-z0-9-]`, 3 to 40 chars), unique per employee. `cron` is a 5-field crontab; two consecutive fires must be at
  least 15 minutes apart. `timezone` defaults to `America/Los_Angeles`. `role` defaults to the caller; another role needs to be in the caller's `canSchedule`.
- Results are delivered to the originating ClickUp task or chat thread. The thread must be a ClickUp one (`deliverTo` must be
  `clickup` or `clickup-chat`), so a schedule cannot be created from a Slack or HTTP conversation.
- At most 20 enabled schedules per employee.
- List with `list_schedules` or `GET /employees/:id/schedules`; remove with `delete_schedule`.
- The tick fires due schedules every minute, as quiet tasks.

The daily digest is separate: if `ALERT_CHANNEL_ID` is set, the control plane posts task counts, cost and PR links for the last 24 hours at
`DIGEST_CRON` (default `0 8 * * *`) in `DIGEST_TZ`.

## Manager and backlogs

Set `MANAGER_ROLE` (for example `manager`) in the environment to turn the manager on. Mechanics:

- A root task started with `managedBy` (`POST /tasks {"managedBy":"manager",...}`) counts as backlog work. When it ends, a wake is recorded.
  Child tasks (`spawn_agent`, workstream stages) never record one, and `spawn_agent` has no `managedBy` option.
- The tick runs the manager role at most once per `MANAGER_DEBOUNCE_SEC` (300). With `MANAGER_HEARTBEAT_MIN` (60) it also runs after that many
  quiet minutes, so a stall is noticed; a heartbeat that finds nothing to do replies `IDLE` and posts nothing. `0` disables the heartbeat.
- The manager role needs `capabilities: [agents, backlog]` and `canSpawn` for the roles it dispatches. Its output goes to `ALERT_CHANNEL_ID`.
- The wake runs for **every** employee with the role id in `MANAGER_ROLE`; an employee without such a role gets failing manager tasks. Give each employee a role with that id, or leave
  `MANAGER_ROLE` unset.
- A backlog is not a schema field. `manager.md` says backlogs are "defined in your role config", but the loader ignores unknown keys, so
  describe each backlog (where the list lives, what "done" means, which role to dispatch, concurrency) in the manager's prompt text.

## dev.yaml explained

`apps/control-plane/roles/dev.yaml` defines one employee, `dev` ("Dev Bot"), with `defaultRole: developer`. Its repo URLs, Azure resource groups and ClickUp channel
ids are placeholders (`your-org`, `my-app-prod`, `abc12-34567`); replace them.

| role | prompt | what it is | runtime | capabilities |
|---|---|---|---|---|
| `assistant` | inline | read-only helper, ClickUp read tools, 25 turns, 15 min | default | none |
| `developer` | `foreman.md` | the default: answers questions, delegates real work, 200 turns, 2.5 h | default | `schedules`, `agents`, `monitors`; spawns the stage roles and `ops`, `compound`; schedules for `assistant`, `ops` |
| `triage`, `spec`, `implement`, `review` | one file each | `sdlc` stages. Can edit and run git, gh, package managers, a scratch Postgres (`pg-scratch`) | `cloudrun`, image `runner-ops` | none |
| `compound` | `compound.md` | runs the compound-engineering `lfg` pipeline to an open PR | `cloudrun` | none |
| `schema-lead`, `schema-implement`, `schema-review` | foreman, implement, review | a lead plus workers pinned to a model (`model: claude-opus-5`), long timeouts (up to 7 h) | `cloudrun` | lead has `agents` |
| `manager` | `manager.md` | owns a backlog; ClickUp in `write` mode; writes no code | default | `agents`, `backlog` |
| `monitor-triage` | `monitor-triage.md` | cheap triage (`model: sonnet`), read-only | default | `agents`; may spawn `developer`, `compound` |
| `ops` | inline | read-only `az` and `gh` | default | none |

It also declares workstreams `sdlc` (entry `developer`) and `compound` (entry `compound`), and monitors `azure-errors` and `clickup-channels`
that both hand findings to `monitor-triage`.

Because most roles use the `azure-user` grant or `runner-ops`, a fresh deployment without Azure should remove those grants and the `azure-errors`
monitor first. A role that names a runtime or image your deployment does not have is not an error at boot; it silently uses the default.

## How to

Each recipe ends with what to redeploy; the rules are in [What to redeploy](#what-to-redeploy).

**Add a role.** Append an entry under `roles:` with an `id`, a prompt, `allowedTools`, `credentials`, limits. To let another role delegate to it, add its id to that role's
`canSpawn`. To make it a pipeline entry point, add a `workstreams:` entry. Rebuild the control-plane image and restart it.

**Change a prompt.** Edit the markdown file (or `systemPrompt`). Rebuild the control-plane image and restart it. The next task uses it; running tasks keep the old text.

**Add a workstream.** Add `workstreams: { name: { entryRole: <role>, description: ... } }` and make sure the roles that should start it have `capabilities: [agents]` and the
entry role in `canSpawn`. Rebuild and restart.

**Add a second employee.** Create `roles/second.yaml` with a different `id`, its own roles and prompts (`systemPromptFile` is resolved against the roles directory,
so a shared prompt file can be reused). Rebuild and restart. It is reachable through `POST /tasks` with `"employeeId":"second"`, through schedules and through its
own monitors. Slack and ClickUp webhooks still go to `DEFAULT_EMPLOYEE_ID`. On Kubernetes it runs in its own namespace.

**Turn a monitor on or off.** Ask the employee ("enable the azure-errors monitor") when a role with `monitors` is reachable: it calls `enable_monitor`. Without such a
role, run SQL against the app database:

```sql
INSERT INTO monitors (employee_id, name, enabled) VALUES ('dev', 'azure-errors', true)
  ON CONFLICT (employee_id, name) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now();
```

Read state with `curl <host>/employees/dev/monitors`. No redeploy: the state is read from the database on every tick. Changing a monitor's definition (interval, config) is a YAML change.

**Add a schedule.** Ask the employee in a ClickUp thread, or trigger a role with `schedules` over ClickUp. There is no YAML or HTTP route to create one without a run token. Inspect with
`curl <host>/employees/dev/schedules`. No redeploy.

**Give a role a new secret.** Add the value to the control plane's environment (and Secret Manager on GCP) and name the grant in the role. Roles can only use the grants in the
[Credentials](#credentials) table; a new kind of secret needs a code change in `resolveCredentials`.

## What to redeploy

The roles directory is read **once, at control-plane boot**. There is no hot reload. The shipped control-plane image copies the whole repo, including
`apps/control-plane/roles`, to `/app`, and every shipped deployment sets `ROLES_DIR=/app/apps/control-plane/roles`. So:

| change | rebuild | restart |
|---|---|---|
| role, workstream, monitor definition, prompt (anything under `roles/`) | control-plane image (`cloudbuild.control-plane.yaml` is the fast path) | control-plane container or revision with the new tag |
| env var or secret | none | control-plane (VM: re-run `apply.sh`, which rewrites `.env`) |
| tools or skills inside the sandbox, Claude Code version | runner image(s) | warm: runner container; Cloud Run: new job image via Terraform |
| cpu/memory of a `cloudrun` role | none | Terraform change to the job in `infra/gcp-cloudrun` |
| monitor on/off, schedules | none | none |

`ROLES_DIR` is an ordinary environment variable, so you can instead mount your own directory into the container and point `ROLES_DIR` at it. No shipped
manifest does that; on the VM you would add a volume to `infra/gcp-vm/startup.sh.tftpl`, on Kubernetes a ConfigMap or volume in `deployment.yaml`. You would still
restart the control plane to re-read it, and `systemPromptFile` paths must stay inside the mounted directory.

Restarting the control plane while tasks run is designed to be safe: DBOS resumes pending workflows at boot and the warm runner keeps its processes. On the VM, recreating the **runner**
container kills the runs inside it, so roll the runner only when nothing is running (`GET /runtime` lists active runs).
