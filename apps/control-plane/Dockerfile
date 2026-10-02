# Build context = repo root: docker build -f apps/control-plane/Dockerfile .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/adapters packages/adapters
COPY apps/control-plane apps/control-plane
RUN pnpm install --frozen-lockfile=false --filter @ai-employee/control-plane...
RUN pnpm -r build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app/apps/control-plane
# Copies dist/, node_modules, and roles/ (ROLES_DIR=/app/apps/control-plane/roles,
# matching infra/k8s/configmap.example.yaml).
COPY --from=build --chown=node:node /app /app
USER node
CMD ["node", "dist/main.js"]
