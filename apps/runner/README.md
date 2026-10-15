# runner

Two images, built from the repo root:

| image | contents | size |
|---|---|---|
| `runner` (`Dockerfile`) | Node 22, Claude Code, ClickUp MCP, git, gh, ripgrep, jq | ~700MB |
| `runner-ops` (`Dockerfile.ops`, FROM runner) | plus Azure CLI | ~1.4GB |

Roles pick an image by name (`image:` in the role YAML). Locally that is the docker tag; on Cloud Run the
adapter maps the image basename to a Job (`runner` → `ai-employee-runner`, `runner-ops` → `ai-employee-runner-ops`).

Smoke test: `docker run --rm --entrypoint bash ai-employee-runner:dev /app/apps/runner/test/toolbelt-smoke.sh`
(`... ai-employee-runner-ops:dev /app/apps/runner/test/toolbelt-smoke.sh ops`).

## Derived images and `bootstrap.d`

Build your own image `FROM` the runner (see `Dockerfile.ops`). Before the agent starts, the bootstrap runs every
executable file in `/etc/ai-employee/bootstrap.d/` (override with `BOOTSTRAP_D_DIR`) in name order, 60s timeout each,
and logs the last stdout line of each. Use it to start sidecars or log in tools the image ships. Failures are non-fatal.
