# Base image contract

Derived images (`FROM` the runner image, see [deploy.md](deploy.md#derived-runner-images-and-bootstrapd)) may rely on these, and the project keeps them stable. Anything not listed here can change between versions.

| path or setting | what it is |
|---|---|
| `/app` | the built workspace (`/app/apps/runner/dist`, `node_modules`) |
| `/usr/local/bin/pg-scratch` | starts a throwaway Postgres in the run's workspace |
| `/usr/local/share/ai-employee/toolbelt-dev.sh` | installs the dev toolbelt (git, gh, ripgrep, jq, ...) on a Debian or Ubuntu base: `COPY --from=<runner image> ... /tmp/toolbelt.sh`, then run it with the target architecture as its argument |
| `/usr/local/bin/ai-employee-tools` | MCP server the agent uses to call back into the control plane |
| uid/gid `1000` (`node`) | the user runs execute as; switch to `USER 0` only to install, then switch back |
| `WORKDIR /workspace` | where repos are cloned and the agent works |
| `ENTRYPOINT ["node", "/app/apps/runner/dist/index.js"]` | do not replace it; add setup as a bootstrap hook |
| `/etc/ai-employee/bootstrap.d/` | executables here run before the agent starts, in name order (override the directory with `BOOTSTRAP_D_DIR`) |

The hook directory is owned by root and not writable by uid 1000. Keep it that way in derived images (`chmod 755`), because hooks run with the run's environment.

Images published by `.github/workflows/images.yml` carry the `org.opencontainers.image.source` label, so the registry links them to the repository.
