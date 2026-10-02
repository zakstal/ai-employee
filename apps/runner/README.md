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
