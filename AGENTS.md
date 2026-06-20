# Repository Guidelines

## Project Structure & Module Organization

This is a local-first academic research agent monorepo. The Python core lives in `services/core/src/academic_agent_core/` and exposes the FastAPI app, LangGraph runner, providers, search tools, schemas, and workspace logic. Python tests are in `services/core/tests/`. The Ink/React terminal UI is in `apps/tui/`, with its CLI entrypoint under `apps/tui/bin/`. Shared TypeScript schema exports live in `packages/schemas/`; files under `packages/schemas/src/generated/` are produced from Python Pydantic schemas. Design and mode notes are in `docs/`, and helper scripts are in `scripts/`. The `.academic-agent/` directory stores local config and runtime workspace data; only safe examples/config should be committed.

## Build, Test, and Development Commands

- `make install`: install Python requirements into the `academic-agent` conda env and install pnpm workspace dependencies.
- `make dev-core`: run the FastAPI core on `127.0.0.1:8765` with reload.
- `make dev-tui`: run the TUI in development mode.
- `pnpm tui` or `pnpm cli`: start the CLI/TUI through the workspace entrypoints.
- `make schema`: regenerate JSON Schema and TypeScript types from Python schemas.
- `make test`: run schema generation, Python tests, and TypeScript typechecks.
- `pnpm -r typecheck`: typecheck all TypeScript packages.

## Coding Style & Naming Conventions

Python targets 3.12, uses Ruff with a 100-character line length, and mypy strict mode. Keep Python modules snake_case, classes PascalCase, and tests named `test_*`. TypeScript packages use ESM, React components in PascalCase, and local variables/functions in camelCase. Treat `services/core/src/academic_agent_core/schemas.py` as the source for generated schema artifacts; regenerate rather than hand-editing generated files.

## Testing Guidelines

Use pytest for core tests in `services/core/tests/`. Add focused tests beside existing foundation tests when changing workspace, providers, search parsing, graph behavior, or API contracts. Run `make test` before submitting changes; for TypeScript-only edits, at least run `pnpm -r typecheck`.

## Commit & Pull Request Guidelines

Recent history uses short imperative subjects, sometimes with conventional prefixes such as `feat:`. Prefer concise messages like `feat: add provider status check` or `Add artifact cleanup tests`. Pull requests should describe the change, list verification commands run, mention schema regeneration when applicable, link related issues/docs, and include screenshots or terminal output for visible TUI changes.

## Security & Configuration Tips

Never commit real API keys. Copy `.academic-agent/.env.example` to `.academic-agent/.env` for secrets, and keep provider/search keys in environment variables. Keep local databases, traces, caches, and generated runtime files out of commits unless they are deliberate fixtures.
