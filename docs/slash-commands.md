# Slash Commands

## General

- `/status` — thread mode, lifecycle, idea version
- `/config` — setup wizard
- `/quit`

## Idea Plan

- `/papers` — search evidence + local PDF manifest + mini-reviews
- `/papers add PATH` — register user-provided PDF (also via `register_local_paper` tool)
- `/convergence` — L/A/F/E convergence checklist
- `/review Reject|Revise|Advance|Provisional [notes]`
- `/meta-review` — AC-style meta-review artifact
- `/freeze` — freeze plan (hard gate)

## Experiment Design

- `/experiment` — start experiment design run (requires frozen plan)
- `/blueprint` — show blueprint draft (via `/artifact` on blueprint)
- `/review-blueprint Freeze|Revise|Reject`
- `/freeze-blueprint` — freeze blueprint

See `apps/academic-agent/src/slash-commands.ts` for the canonical list.
