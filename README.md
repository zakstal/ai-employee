# AI Employee

An AI developer you run on your own cloud. You give it tasks from chat (ClickUp, Slack), over HTTP, on a schedule, or
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

## Deploy

| Option | What runs where | Guide |
|---|---|---|
| VM (recommended) | One VM runs the control plane, a warm runner and HTTPS; heavy roles run as Cloud Run jobs | [deploy.md › VM](docs/deploy.md) |
| Cloud Run | Everything on Cloud Run with Cloud SQL | [deploy.md › Cloud Run](docs/deploy.md) |
| Kubernetes | Control plane and runners as pods | [deploy.md › Kubernetes](docs/deploy.md) |

## Security

Some HTTP routes have **no login**: `POST /tasks`, `GET /tasks/:id`, `/employees/*`, `/runtime`, `/status`, `/stats`.
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
