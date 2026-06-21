# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/agent-runtime/package.json apps/agent-runtime/
COPY packages/agent-core/package.json packages/agent-core/
COPY packages/activity-ui/package.json packages/activity-ui/
COPY packages/config/package.json packages/config/
COPY packages/harness/package.json packages/harness/
COPY packages/pdf-ingest/package.json packages/pdf-ingest/
COPY packages/providers/package.json packages/providers/
COPY packages/schemas/package.json packages/schemas/
COPY packages/search/package.json packages/search/
COPY packages/workspace/package.json packages/workspace/
COPY packages/workspace-pg/package.json packages/workspace-pg/
COPY packages/workspace-port/package.json packages/workspace-port/

RUN pnpm install --frozen-lockfile

COPY packages ./packages
COPY apps/agent-runtime ./apps/agent-runtime
COPY tsconfig.json ./tsconfig.json

RUN pnpm --filter @academic-agent/workspace-pg build \
  && pnpm --filter @academic-agent/agent-runtime typecheck

FROM node:22-alpine AS production
WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable \
  && addgroup -S agent && adduser -S agent -G agent

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/agent-runtime/package.json apps/agent-runtime/
COPY packages/agent-core/package.json packages/agent-core/
COPY packages/activity-ui/package.json packages/activity-ui/
COPY packages/config/package.json packages/config/
COPY packages/harness/package.json packages/harness/
COPY packages/pdf-ingest/package.json packages/pdf-ingest/
COPY packages/providers/package.json packages/providers/
COPY packages/schemas/package.json packages/schemas/
COPY packages/search/package.json packages/search/
COPY packages/workspace/package.json packages/workspace/
COPY packages/workspace-pg/package.json packages/workspace-pg/
COPY packages/workspace-port/package.json packages/workspace-port/

RUN pnpm install --frozen-lockfile \
  && pnpm rebuild deasync || true

COPY packages ./packages
COPY apps/agent-runtime ./apps/agent-runtime
COPY --from=build /app/packages/workspace-pg/dist ./packages/workspace-pg/dist

USER agent

WORKDIR /app/apps/agent-runtime
CMD ["pnpm", "start"]
