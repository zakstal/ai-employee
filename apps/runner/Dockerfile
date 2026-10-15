# `dev` runner image (~700MB): Node, Claude Code, ClickUp MCP, git, gh, ripgrep, jq.
# Build context: repo root.   docker build -f apps/runner/Dockerfile -t ai-employee-runner:dev .
FROM node:22-slim AS builder
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/runner apps/runner
RUN pnpm install --frozen-lockfile=false --filter @ai-employee/runner...
RUN pnpm -r build

FROM node:22-slim
ARG TARGETARCH
# Rarely-changing layers first so app redeploys pull only the last layer.
# The script stays in the image (base-image contract) so a derived image on another OS base can run it too.
COPY apps/runner/toolbelt-dev.sh /usr/local/share/ai-employee/toolbelt-dev.sh
RUN chmod 755 /usr/local/share/ai-employee/toolbelt-dev.sh && /usr/local/share/ai-employee/toolbelt-dev.sh "${TARGETARCH:-$(dpkg --print-architecture)}"
RUN npm install -g @anthropic-ai/claude-code@2.1.270 @hauptsache.net/clickup-mcp@1.9.0 && npm cache clean --force
# Claude Code refuses to run as root; node:22-slim ships uid 1000 (`node`).
RUN mkdir -p /workspace && chown node:node /workspace
# Hook directory for derived images (see docs/base-image-contract.md). Root-owned, not writable by the run's user.
RUN mkdir -p /etc/ai-employee/bootstrap.d && chmod 755 /etc/ai-employee/bootstrap.d
# compound-engineering skills (EveryInc, MIT) installed as user skills so `lfg`, `ce-plan`, `ce-work`, ... resolve headless.
ARG CE_REF=84bdf8c
RUN git clone -q https://github.com/EveryInc/compound-engineering-plugin /tmp/ce && git -C /tmp/ce checkout -q "$CE_REF" \
 && mkdir -p /home/node/.claude/skills /home/node/.claude/projects && cp -r /tmp/ce/skills/. /home/node/.claude/skills/ && rm -rf /tmp/ce \
 && chown -R node:node /home/node/.claude
COPY --from=builder /app /app
COPY apps/runner/pg-scratch.sh /usr/local/bin/pg-scratch
RUN chmod +x /usr/local/bin/pg-scratch
COPY apps/runner/test/toolbelt-smoke.sh /app/apps/runner/test/toolbelt-smoke.sh
RUN ln -s /app/apps/runner/dist/tools-mcp.js /usr/local/bin/ai-employee-tools && chmod +x /app/apps/runner/dist/tools-mcp.js
RUN ln -s /app/apps/runner/dist/credential.js /usr/local/bin/ai-employee-credential && chmod +x /app/apps/runner/dist/credential.js
COPY apps/runner/gh-refresh.sh /usr/local/bin/gh
RUN chmod 755 /usr/local/bin/gh
USER 1000:1000
WORKDIR /workspace
ENV DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ENTRYPOINT ["node", "/app/apps/runner/dist/index.js"]
