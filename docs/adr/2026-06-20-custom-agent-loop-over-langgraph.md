# LangGraph.js Spike Conclusion

## Decision

**Use a custom TypeScript agent loop** (`packages/agent-core/src/loop.ts`) instead of `@langchain/langgraph` for v1 migration.

## Context

The legacy Python core used LangGraph only for a thin three-node cycle:

```text
agent -> tools -> agent -> finalize
```

Most complexity lived outside LangGraph in:

- artifact-first context building
- history compaction and conversation summaries
- workspace-backed SSE events
- cancel via `RunCancelled` + SQLite run status (not LangGraph interrupt)

## Comparison

| Criterion | Custom loop | LangGraph.js |
|-----------|-------------|--------------|
| Bundle size | Smaller | Heavier (@langchain/*) |
| Cancel/resume today | Matches existing workspace model | Checkpoint/HITL primitives (unused in v1) |
| Port effort | Direct translation of Python flow | Rewire state + checkpoint adapters |
| Future 5-mode graph | Need `ModeGraph` interface | Built-in subgraph/checkpoint support |
| kimi-code alignment | Yes | No |

## Recommendation

- **v1 migration**: custom loop (implemented)
- **v2 multi-mode workflow**: re-evaluate LangGraph.js when Experiment Design / Execution modes need checkpoint/time-travel/HITL at graph level

## Spike artifact

`packages/agent-core/src/langgraph-spike.test.ts` records this decision in CI.
