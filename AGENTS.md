# Repository Guidelines

## Project Structure & Module Organization

This is a local-first academic research agent monorepo written in **TypeScript**. The CLI/TUI entry point is `apps/academic-agent/`. Core logic lives in `packages/`:

- `agent-core` — Idea Plan runner and custom agent loop
- `workspace` — SQLite + `.academic-agent/` persistence
- `config` — TOML + env configuration
- `harness` — artifacts, memory, cache, traces
- `providers` — LLM adapters (OpenAI, Anthropic, DeepSeek; RecordedProvider for CI)
- `search` — paper/web search and tool registry
- `schemas` — Zod contracts (source of truth)
- `core-service` — in-process API used by the TUI

Design notes live in `docs/`. Helper scripts are in `bin/`. The `.academic-agent/` directory stores local runtime data.

## Build, Test, and Development Commands

- `make install` — install pnpm workspace dependencies (builds `better-sqlite3` if needed)
- `make dev` — run the TUI in development mode
- `pnpm tui` or `pnpm cli` — start the CLI
- `make test` — Vitest + runtime launcher tests
- `pnpm -r typecheck` — typecheck all TypeScript packages

## Coding Style & Naming Conventions

TypeScript packages use ESM. React components in PascalCase; functions and variables in camelCase. Python-style snake_case is preserved on workspace/harness methods ported from the legacy core for behavioral parity. Zod schemas in `packages/schemas` are the contract source — do not hand-edit generated artifacts.

## Testing Guidelines

Use Vitest in `tests/` and `packages/**/*.test.ts`. Run `make test` before submitting changes. CI uses **RecordedProvider** with fixtures under `tests/recordings/` (set `ACADEMIC_AGENT_RECORDED_PROVIDER=1` and `ACADEMIC_AGENT_RECORDINGS_DIR`).

## Commit & Pull Request Guidelines

Recent history uses short imperative subjects, sometimes with conventional prefixes such as `feat:`. Pull requests should describe the change, list verification commands run, and include terminal output for visible TUI changes.

## Security & Configuration Tips

Never commit real API keys. Copy `.academic-agent/.env.example` to `~/.academic-agent/.env` for global secrets. Keep local databases, traces, caches, and runtime files out of commits unless they are deliberate fixtures. Use RecordedProvider fixtures for deterministic tests without live API keys.
