# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/activity-ui/package.json packages/activity-ui/
COPY packages/agent-core/package.json packages/agent-core/
COPY packages/config/package.json packages/config/
COPY packages/harness/package.json packages/harness/
COPY packages/pdf-ingest/package.json packages/pdf-ingest/
COPY packages/providers/package.json packages/providers/
COPY packages/schemas/package.json packages/schemas/
COPY packages/search/package.json packages/search/
COPY packages/workspace/package.json packages/workspace/

RUN pnpm install --frozen-lockfile || pnpm install

COPY contracts/openapi/platform.v1.yaml contracts/openapi/platform.v1.yaml
COPY packages/ packages/
COPY apps/web/ apps/web/

WORKDIR /app/apps/web
RUN pnpm run generate-api-types
RUN pnpm run build

FROM nginx:alpine
COPY deploy/docker/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
