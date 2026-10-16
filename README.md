# AI Employee

An AI developer you run on your own cloud. You give it tasks from chat (ClickUp, Slack, Telegram), over HTTP, on a schedule, or
from a monitor that watches for errors. Each task runs Claude Code in its own sandbox, with the role, tools, repos and
logins you configured. It answers in the thread it came from and opens pull requests. It never merges.

## How it works

1. A task arrives (chat message, `POST /tasks`, schedule, or monitor).
2. The **control plane** picks the employee and role, and records the task.
3. It starts a **sandbox** (a container): Claude Code with that role's prompt, allowed tools, cloned repos and logins.
4. The agent works. A coordinating role can start other roles as sub-tasks and wait for them.
5. The result goes back to the thread, the PR, or the caller.

Everything an employee can do is defined in one YAML file.

## The YAML

One file per employee, in `apps/control-plane/roles/`. This is a complete, working example:

```yaml
id: dev                           # the employee
name: Dev Bot
defaultRole: developer            # role used when a task doesn't name one

roles:
  - id: developer                 # the coordinator: talks to people, delegates the work
    description: Takes requests and runs them through triage → spec → implement → review.
    systemPromptFile: prompts/foreman.md
    allowedTools: [Read, Grep, Glob]
    capabilities: [agents]        # may start other roles
    canSpawn: [triage, spec, implement, review]
    credentials: [claude-subscription, clickup]

  - id: implement                 # a stage: does one job and reports back
    systemPromptFile: prompts/implement.md
    allowedTools: [Read, Grep, Glob, Edit, Write, "Bash(git *)", "Bash(gh *)", "Bash(pnpm *)"]
    repos:
      - url: https://github.com/your-org/your-app.git
    credentials: [claude-subscription, github]
    runtime: cloudrun             # run in an isolated Cloud Run job
    maxTurns: 400
    timeoutSec: 5400

  # triage, spec and review are defined the same way

workstreams:                      # named flows other roles can start
  sdlc:
    entryRole: developer
    description: triage → spec → implement → review

monitors:                         # background checks; no AI runs until something new turns up
  app-errors:
    collector: azure-errors
    everyMin: 5
    role: monitor-triage          # the role that handles what it finds
    config: { apps: [{ rg: my-resource-group, name: my-app-insights }] }
```

What the fields mean:

| Field | Meaning |
|---|---|
| `roles[].systemPrompt` / `systemPromptFile` | The role's instructions: inline, or a file under `roles/` |
| `roles[].allowedTools` | The only tools it may use; everything else is refused |
| `roles[].capabilities` | Extra powers: `agents` (start other roles), `schedules`, `monitors`, `backlog` |
| `roles[].canSpawn` | Which roles it may start |
| `roles[].credentials` | Which logins the sandbox gets: `claude-subscription`, `anthropic`, `github`, `clickup`, `azure`, `azure-user` |
| `roles[].repos` | Repos cloned into the sandbox (`ref` picks a branch) |
| `roles[].runtime` | Where it runs: default warm runner, or `cloudrun` |
| `workstreams` | A named starting point for a flow (see below) |
| `monitors` | Background collectors and the role that handles what they find |

The full field list is in [docs/configuration.md](docs/configuration.md).

**Changing it:** edit the YAML or a prompt, rebuild the control-plane image, redeploy. Config is read once at start.

## Flows

A flow is a role that coordinates other roles. The steps live in that role's **prompt**. The YAML only says which
roles it may start (`canSpawn`) and gives the flow a name (`workstreams`).

**1. A request from chat** (`sdlc`, run by `developer` with `prompts/foreman.md`)

1. **Triage**: find the cause and scope, create or link a ClickUp task. Skipped for trivial work.
2. **Spec**: only if the work is ambiguous. A person must approve it.
3. **Implement**: make the change, open a pull request.
4. **Review**: one review. Clear fixes go back to implement; judgment calls go to the person on the PR.
5. **Hand off**: post the PR, set the task to "in review". A person merges.

Sub-tasks remember nothing, so the coordinator gives each one a full brief and waits for it (`spawn_agent`, `wait_for`).
It stops for a person at three points: spec approval, any question (`ask_human`), and PR hand-off.

**2. A monitor finds something** (`monitors:`)

The collector checks a source every few minutes (Azure errors, a ClickUp channel). When something new shows up, it starts
its role with a brief marked `AUTONOMOUS:`. That role runs the same steps without waiting for spec approval, unless the
change is risky.

**3. A schedule** (created by an agent with `create_schedule`)

A cron time, a role and a prompt. At that time the role runs and posts its result to a thread.

**4. A backlog** (`MANAGER_ROLE=manager`)

Tasks started with `"managedBy": "manager"` count as backlog work. When one finishes, the manager wakes, looks at the
backlog described in its prompt, and starts the next item that's ready.

## Agents talking to each other

Agents run as separate tasks that cannot receive inbound requests, so the control plane keeps a message board per
employee. Any role can use it, no capability needed:

- `send_message(channel, text, to?)`: post to a channel (`[a-z0-9._-]`, up to 100 chars; text up to 8000). Leave `to` empty
  to reach everyone on the channel, or pass a task id to address one agent.
- `read_messages(channel, since?, wait_seconds?)`: new messages from others (never your own). Pass the last id you saw
  as `since`. `wait_seconds` (up to 25) holds the call open until something arrives.

Use it to claim shared files, announce pushed fixes, or ask another agent a question. Messages are stored in
`agent_messages` in the A2A `Message` shape (`role`, `messageId`, `contextId` = channel, `parts`), so an A2A endpoint
can be added later. Routes: `POST` and `GET /agents/self/messages`, authenticated like the other `/agents/self/*` routes.

## Claude accounts, usage and limits

One employee can hold several Claude subscriptions (tokens from `claude setup-token`) and spread work across them. The
control plane tracks each account's usage, gives every task an account with headroom, and deals with a task hitting a
usage limit mid-run instead of letting it die.

**Accounts.** Every env var `CLAUDE_CODE_OAUTH_TOKEN_<NAME>` is an account called `<name>` (lowercased). A lone legacy
`CLAUDE_CODE_OAUTH_TOKEN` is the account `default`. Tokens are never logged or returned; accounts are identified by name
and a 12-character sha256 fingerprint. Roles that list the built-in `claude-subscription` grant get one account per task,
injected as `CLAUDE_CODE_OAUTH_TOKEN` (the runner and `claude` read the same variable). The account name is stored on the
task (`tasks.claude_account`) and shown on its `started` event.

**Usage.** Every `CLAUDE_USAGE_CHECK_MIN` minutes (default 5) a scheduled job sends a 1-token `POST /v1/messages` per
account and reads the `anthropic-ratelimit-unified-*` response headers: 5-hour and 7-day status, utilization (0..1) and
reset time, plus overage status and `overage-in-use` (whether the account is being billed to paid overage right now). (`GET /api/oauth/usage` rejects setup-token tokens, so it is not used.) The result is kept
in `claude_account_usage`. A task that ends on `You've hit your session limit · resets 5:40pm (UTC)` also marks its account
as out until that reset. When an account's 5h or 7d utilization reaches `warnAt`, one alert goes to `ALERT_CHANNEL_ID`
per window.

**Settings.** Stored in Postgres and read on every decision, so changes apply immediately, with no deploy or restart:

| Setting | Default | Meaning |
|---|---|---|
| `limitPolicy` | `failover-then-wait` | `failover`: switch to another account. `wait`: sleep until the account's window resets. `failover-then-wait`: switch if any account has headroom, else wait for the earliest reset. `off`: do nothing special; a limit ends the task as it always did, and launch never refuses. |
| `allowOverage` | `false` | Let tasks use accounts that have spilled into paid overage. |
| `warnAt` | `0.8` | Alert threshold (0..1) on the 5h and 7d windows. |
| `preferred` | `[]` | Account names in order of preference; empty = most 5h headroom first. |

**Routes.** `GET /usage` (per-account snapshot and current settings), `POST /usage/refresh` (probe now),
`GET /settings/claude`, `PUT /settings/claude` (any subset of the settings; unknown keys and bad values are a 400). Set `ADMIN_TOKEN` and these routes (and `/usage`, `/usage/refresh`) require `Authorization: Bearer <ADMIN_TOKEN>` — do, unless the network already restricts them: `PUT /settings/claude` can turn on paid overage.
These have no login, like `/runtime`: restrict them at the network layer. Agents get `GET /agents/self/usage`
(the `usage_status` MCP tool) and the runner uses `POST /agents/self/limit`; both take the run token.

**Choosing an account.** At launch an account is skipped when its 5h or 7d status is not `allowed` (`allowed_warning`
counts as allowed), its utilization is 0.98 or more, or, unless `allowOverage`, it is being billed to overage right now
(`overage-in-use: true` or `representative-claim: overage`). The overage meter alone (`overage-utilization`, which stays above 0 for
the rest of the month after any spill) does not count. A window whose reset time
has passed counts as clear. Of the rest, `preferred` order wins, else the most 5h headroom. An account never probed counts
as available. If none qualifies: `wait` and `failover-then-wait` hold the task (queued) until the earliest reset, then try
again; `failover` fails it with a clear message.

**A limit hit mid-run.** The runner spots the limit message, holds it back (so it is not taken as the task's answer),
reports a `limit_hit` event and asks the control plane what to do. On `failover` it switches to the returned token; on
`wait` it sleeps until the reset time plus 60 seconds, sending a `heartbeat` event every 2 minutes. Then it resumes the
same Claude session (`--resume <session id>`) with: "You hit a usage limit; the employee switched account (or waited).
Continue where you left off; any build that failed during the outage must be rerun." At most 3 recoveries per task. If a
wait would outlast the task's own time limit (`TASK_TIMEOUT_SEC`, the role's `timeoutSec`), the runner ends the task with the
limit message instead. This works the same for the warm runner and Cloud Run jobs, since the container stays alive.

**`token-refresh.d`.** After a switch, the runner runs every executable in `/etc/ai-employee/token-refresh.d/` (override:
`TOKEN_REFRESH_D_DIR`), in name order, 60 s each, with the new token in `CLAUDE_CODE_OAUTH_TOKEN` (and `CLAUDE_ACCOUNT`).
Derived images use it to refresh files other processes read. For example, an image whose Fabro agent sources
`~/.fabro/claude.env`:

```sh
#!/bin/sh
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$CLAUDE_CODE_OAUTH_TOKEN" > "$HOME/.fabro/claude.env"
```

A failing hook is logged and does not stop the others. Hooks never run for the first token, only on a switch.

## Run it locally

You need Node 22+, pnpm, Docker and the `claude` CLI, plus an Anthropic API key or a `claude setup-token` token.

```sh
make dev                        # Postgres in Docker
pnpm install && pnpm -r build
cp .env.example .env            # set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
set -a; . ./.env; set +a        # the control plane doesn't read .env itself
pnpm --filter @ai-employee/control-plane start

curl -s localhost:3000/tasks -H 'content-type: application/json' \
  -d '{"employeeId":"dev","roleId":"assistant","prompt":"Summarise the files in your working directory.","taskKey":"demo1"}'
curl -s localhost:3000/tasks/http:dev:demo1      # status and result
```

Open `http://localhost:3000/status` to watch it.

## Telegram

Talk to your employee 1:1 from Telegram. Private text messages only; it replies in the same chat (a `…` placeholder that
is edited as it works, then replaced by the answer), and follow-ups continue the same conversation.

1. In Telegram, message **@BotFather**, send `/newbot`, and copy the bot token.
2. Set the env vars on the control plane:
   - `TELEGRAM_BOT_TOKEN`: the token from BotFather. Empty disables the channel.
   - `TELEGRAM_WEBHOOK_SECRET`: any random string (letters, digits, `_`, `-`).
   - `TELEGRAM_ALLOWED_CHAT_IDS`: comma-separated numeric chat ids. Anyone else is ignored and never answered.
   - `TELEGRAM_EMPLOYEE_ID`: optional; defaults to `DEFAULT_EMPLOYEE_ID`.
   - `TELEGRAM_ROLE`: optional; the role that handles Telegram messages. Defaults to the employee's `defaultRole`.
   - `OWNER_TELEGRAM_CHAT_ID`: optional; the owner's chat for messages the employee sends on its own. Defaults to the first `TELEGRAM_ALLOWED_CHAT_IDS` entry.
3. Find your chat id: message your bot once (it will not answer), then open
   `https://api.telegram.org/bot<token>/getUpdates` and read `message.chat.id` (or ask @userinfobot). Put it in
   `TELEGRAM_ALLOWED_CHAT_IDS` and restart.
4. Register the webhook (needs a public HTTPS `PUBLIC_BASE_URL`; never done automatically):

```sh
node dist/cli/telegram.js set-webhook      # sends ${PUBLIC_BASE_URL}/webhooks/telegram, the secret, allowed_updates ["message"]
node dist/cli/telegram.js info             # current webhook, pending updates, last error
node dist/cli/telegram.js delete-webhook
```

`ask_human` questions from the agent arrive in the chat; your next message is the answer.

### Operating the employee from chat

The owner can see everything, control running work and change account settings by talking to the employee. Nothing here is a
slash command: the chat role calls tools from the built-in `ai_employee` MCP server, so you ask in plain words ("what is
running?", "stop the review task", "start an ops task to check the Azure errors and send me the result", "turn overage on").

**See (every role, no capability).**

| Tool | What it returns |
|---|---|
| `employee_status` | Every running, queued or waiting task of the employee from any source (http, ClickUp, ClickUp chat, Slack, Telegram, schedules, subagents): id, role, source channel, parent and root task, age, Claude account, cost so far, and the latest progress line (the last thing the agent said). Then the last 24 hours of finished tasks (status, one-line result), then every Claude account's 5h/7d utilization, reset time and availability, and the current settings. Backed by `GET /agents/self/status`. |
| `list_tasks` | Recent tasks of the employee, any status. No longer needs the `backlog` capability. |
| `message_owner` | See [Messaging the owner](#messaging-the-owner). |

Cost so far is only known once a task has finished: Claude Code reports cost in its final result, so a running task shows `-`.

**Control (roles with the `operate` capability).**

| Tool | Does | Route |
|---|---|---|
| `start_task(role, prompt, task_key?, reply_to?)` | Starts a top-level task, as if `POST /tasks`. `reply_to: "telegram"` sends its final result to the owner's chat. `task_key` makes the call idempotent. | `POST /operator/tasks` |
| `cancel_task(task_id)` | Cancels any task of the employee, not only the caller's children. Finished tasks are left alone; a task cannot cancel itself. | `POST /operator/tasks/:id/cancel` |
| `task_events(task_id, since?, limit?)` | The event stream (text, tool calls, results) of any task of the employee. | `GET /operator/tasks/:id/events` |
| `claude_settings(action, limitPolicy?, allowOverage?, warnAt?, preferred?)` | `get` reads, `set` changes only the fields given, with the same validation as `PUT /settings/claude`. Takes effect on the next decision. | `GET`/`PUT /operator/settings/claude` |

These routes are authenticated with the run token like the other `/agents/self/*` routes, and a role without `operate` gets
`403 role <id> lacks the "operate" capability`. Another employee's tasks look absent (404). `claude_settings` can enable
paid overage, so give `operate` only to the role you chat with. `dev.yaml` gives it to `developer`, the default role.

**Replies for HTTP and scheduled work.** `POST /tasks` accepts `"replyTo": {"channel": "telegram"}` (optional `"chat"`, which must be an
allowed chat; it defaults to the owner's). The task runs quietly, with no placeholder, and its final result is sent to that chat.
A schedule's `deliverTo` accepts `{channel: telegram}` the same way (in `dev.yaml` style config, `threadRef` may be left out for the
owner's chat), and a schedule created from a Telegram conversation delivers back to that chat. Without `replyTo` nothing changes.

```sh
curl -s localhost:3000/tasks -H 'content-type: application/json' \
  -d '{"employeeId":"dev","roleId":"ops","prompt":"Check Azure errors for the last hour.","replyTo":{"channel":"telegram"}}'
```

### Messaging the owner

Any role can call `message_owner(text)` (`POST /agents/self/message-owner`) to tell the owner something without being asked: a result, a
blocker, a decision needed. It goes to the owner's Telegram chat (`OWNER_TELEGRAM_CHAT_ID`, else the first `TELEGRAM_ALLOWED_CHAT_IDS`
entry). If Telegram is not configured it falls back to the ClickUp `ALERT_CHANNEL_ID`; with neither it returns an error to the agent.
Text over 4096 characters is split into several messages. Each task may send at most 20 per hour (HTTP 429 after that); the counter is
in memory and resets on restart.

Alerts use the same owner chat. Failure alerts, Claude usage warnings, backlog guard alerts, the daily digest and monitor/manager
reports go to ClickUp as before; set `ALERT_TELEGRAM=1` to send them to the owner's Telegram chat as well (with the flag and no
`ALERT_CHANNEL_ID`, Telegram alone gets them).

## Deploy

| Option | What runs where | Guide |
|---|---|---|
| VM (recommended) | One VM runs the control plane, a warm runner and HTTPS; heavy roles run as Cloud Run jobs | [deploy.md › VM](docs/deploy.md) |
| Cloud Run | Everything on Cloud Run with Cloud SQL | [deploy.md › Cloud Run](docs/deploy.md) |
| Kubernetes | Control plane and runners as pods | [deploy.md › Kubernetes](docs/deploy.md) |

## Security

Some HTTP routes have **no login**: `POST /tasks`, `GET /tasks/:id`, `/employees/*`, `/runtime`, `/status`, `/stats`, and `/usage`, `/settings/claude` unless `ADMIN_TOKEN` is set.
Anyone who can reach them can start tasks with your logins. Before exposing the host, restrict those routes (an IP
allowlist at the proxy, a VPN, or IAP). Webhooks and agent routes have their own secrets.

## Limitations today

- Config is built into the image; changing it means a redeploy.
- Schedules can't be written in YAML yet.
- Unknown YAML keys are ignored silently, so a typo does nothing.
- Backlogs are described in the manager's prompt, not in YAML.

## More

- [docs/configuration.md](docs/configuration.md): every field, and how-tos (add a role, a workstream, an employee)
- [docs/deploy.md](docs/deploy.md): each deploy option step by step
- [docs/architecture.md](docs/architecture.md): how the pieces fit
