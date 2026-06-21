# Git Branch Strategy (`tui` / `web`)

## Branches

| Branch | Purpose | Primary paths |
|--------|---------|---------------|
| **`tui`** | Local terminal product | `apps/academic-agent`, TUI UX, `packages/agent-core` SQLite path |
| **`web`** | SaaS Web product | `apps/web`, `apps/agent-runtime`, `services/platform-java`, `deploy/` |
| **`main`** | Optional integration / release | Merge from `tui` or `web` at tagged releases |

Remote: `origin/tui`, `origin/web` (same names on GitHub).

## Shared packages

Both branches share `packages/*` (agent-core, schemas, harness, providers, search, workspace, etc.).

```
         packages/agent-core (shared kernel)
                /            \
           tui branch        web branch
     apps/academic-agent     apps/web + platform-java + agent-runtime + deploy/
```

## Sync rules

1. **Kernel changes** — land on the branch where work started; cherry-pick or open a PR to the other branch weekly or per release.
2. **Web-only** — `deploy/`, `services/platform-java/`, `apps/web/`, `apps/agent-runtime/`.
3. **TUI-only** — Ink TUI details, local `.academic-agent` workflow docs.
4. **Cross-cutting kernel** — prefer **tui first** (mature local path), then port to `web`.

## PR targets

- TUI features → `tui`
- Web / SaaS / deploy / Java → `web`
- Shared `packages/*` → discuss; usually tui first, then sync to web

## Tags

- `tui-v*` — terminal releases
- `web-v*` — SaaS releases

## Protection (recommended on GitHub)

- Required CI, ≥1 review, no force push on `tui` and `web`
- `web` additionally: Compose full-stack smoke test
