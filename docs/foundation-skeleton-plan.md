# Foundation Skeleton Implementation Plan

## Summary

v0 骨架采用 local-first monorepo，目标是跑通最小 vertical slice：

```text
TUI 输入 research idea
-> FastAPI 创建 Idea Plan run
-> Single-node LangGraph 执行 IdeaPlanStub
-> ContextBuilder stub 构造最小 context
-> Mock provider 返回五字段诊断
-> 生成 ResearchIdeaPlanDraft artifact
-> SSE 推送事件到 TUI
-> SQLite + files 写入 run / event / trace / artifact
```

v0 不实现完整学术能力，只验证跨栈边界、schema、事件流、存储、trace 和 artifact 生命周期。

## Structure

- `apps/tui`: TypeScript + Ink + React TUI。
- `services/core`: Python FastAPI + LangGraph + Pydantic core。
- `packages/schemas`: 由 Pydantic schema 生成的 TypeScript types。
- `scripts/export_schema.py`: schema 生成入口。

## Commands

- `make install`
- `make dev-core`
- `make dev-tui`
- `make schema`
- `make test`

## v0 Boundaries

- Provider 使用 deterministic mock，不接 OpenAI / Anthropic。
- LangGraph 使用 single-node `IdeaPlanStub`。
- Memory/context harness 只提供最小模块边界。
- Artifact 使用 Markdown + JSON metadata。
