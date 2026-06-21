# Web Engineering Standards

Applies to the **`web`** branch: `apps/web`, `apps/agent-runtime`, `services/platform-java`, `deploy/`.

## Principles

- **High cohesion, low coupling** — module boundaries via interfaces and contracts only.
- **Reuse** — domain logic in `packages/*`; platform in Spring / Vue ecosystems.
- **No hand-rolled generic UI** — use Naive UI + Tailwind; no custom Button/Modal/Table stacks.
- **No mock in delivery paths** — real DB, Kafka, LLM, search; see `deploy/scripts/check-no-mock.sh`.

## Structured logging

### Correlation fields

| Field | Scope |
|-------|--------|
| `traceId` | Single HTTP request (header `X-Trace-Id`) |
| `userId` | Authenticated user |
| `runId` | Agent run |
| `threadId` / `projectId` | Research context |
| `span` | `gateway` \| `identity` \| `research` \| `sse` \| `agent` \| `kafka` |

### Stack

| Runtime | Library |
|---------|---------|
| platform-java | SLF4J + Logback JSON + MDC |
| agent-runtime | pino |
| nginx | `$request_id` → `X-Trace-Id` |

### Never log

API keys, passwords, full JWT refresh tokens.

## Architecture

```
apps/web          → OpenAPI client + Vue ecosystem only
platform-java     → gateway → identity | research | sse (service interfaces)
agent-runtime     → agent-core + WorkspacePort + Kafka
packages/*        → no imports from apps/*
```

## Enforcement

- Java: ArchUnit (`services/platform-java/app/src/test/java/.../ArchitectureTest.java`)
- TS: ESLint `import/no-restricted-paths` in `apps/web` and `packages/*`
- DB: Flyway migrations only
- API: OpenAPI first → `openapi-typescript` for web client

## PR checklist

- [ ] Correct module / package placement
- [ ] Structured logs on error paths with `traceId` / `runId`
- [ ] No duplicate logic vs existing `packages/*`
- [ ] UI uses component library
- [ ] Public APIs in `contracts/openapi/platform.v1.yaml`
- [ ] No mock / RecordedProvider in web deliverables
