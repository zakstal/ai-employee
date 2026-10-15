# Architecture decisions (2026-09-13)

Chosen on merit, explicitly not inherited from other internal projects.

| concern | choice | why | alternative kept warm |
|---|---|---|---|
| language | TypeScript / Node LTS | Claude Code, Gemini CLI, Agent SDK, Slack Bolt are TS-first | Python |
| durable execution | DBOS (in-process, Postgres) | $0, no extra infra, workflowID dedup, send/recv, cron, queues | Temporal (adapter + body swap) |
| HTTP | Fastify | raw body for HMAC, schema validation, small | anything |
| store | Postgres only | ledger + DBOS system DB | — |
| sandbox | Kubernetes Jobs | isolation per task, namespace per employee | Namespace Labs, Cloud Run Jobs (same adapter) |
| harness | Claude Code headless (`-p --output-format stream-json`) | fewest moving parts; events already NDJSON | ACP when Gemini is added |
| model access | Vertex AI on GCP, direct API elsewhere | Workload Identity, no key files | — |

## Identity model

- **Employee** – durable. Roles, credentials, memory, task ledger.
- **Conversation** – per channel thread. A transcript pointer to one employee.
- **Task** – one workflow run. Owned by the employee, not the conversation.

Two conversations see the same ledger, so both know what is running. `taskId` is the
dedup key at two layers: `tasks` row insert (`ON CONFLICT DO NOTHING`) and the DBOS workflow ID.

## Task lifecycle

`queued → running → done | failed | cancelled` (`awaiting_input` reserved for human-in-the-loop via `signal`).

## Security posture (milestone 1)

- Runner runs as non-root in default permission mode with `--permission-prompts none`, so anything outside the role's `allowedTools` is denied; Kubernetes Jobs also get `activeDeadlineSeconds`.
- Per-run bearer token (sha256 stored) for the event sink, TTL = role timeout + 10 min.
- Slack signatures verified over raw bytes, 5-minute replay window.
- Not yet: egress NetworkPolicy, gVisor RuntimeClass, minted short-lived provider tokens (currently static env). Tracked in backlog.

## Rules that keep the adapters cheap to swap

- The workflow body (`apps/control-plane/src/orchestration/workflow.ts`) only sequences steps. No clock, no IO, no env.
  It follows Temporal's determinism rules even though DBOS does not require them.
- The runner pushes events; adapters never tail logs.
- Credentials are injected per run via env. Workload Identity is a Kubernetes-only shortcut, not a dependency.
- Sub-agents are child tasks through the control plane, not Claude Code in-process subagents.
