# Academic Agent

Academic Agent 是一个 local-first 的学术研究 agent 原型。当前版本聚焦 AI/ML 顶会 research idea 的早期规划：用户在 TUI 里提出研究想法，core 通过 Idea Plan Mode、论文/网页检索、上下文管理和 artifact/trace 记录，产出可继续审查的 `ResearchIdeaPlanDraft`。

项目目标不是做一个普通聊天机器人，而是逐步搭建一个可恢复、可审计、可复现的学术工作流：

```text
ResearchIdeaPlan frozen
-> Experiment Blueprint frozen
-> Execution Package frozen
-> Result Analysis Report frozen
-> Manuscript Package frozen
```

目前代码实现仍处在 v0/v1 过渡阶段，完整闭环尚未实现。

## 当前进展

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| Foundation Skeleton | 可运行 | TypeScript monorepo：Ink TUI + agent-core + SQLite workspace |
| Idea Plan Mode | v0 可用 | 支持多轮 idea 诊断、检索、working trace、artifact 更新和 final synthesis fallback |
| Memory / Context / Compact | v0.5 | 支持 context usage、双层 compact、conversation summary、trace；尚未实现完整 semantic retrieval / rehydrate |
| Search / Tool Loop | v0.5 | 支持 arXiv、OpenAlex、Tavily 等；有 arXiv fallback query、429 cooldown、部分失败显示 |
| Session / TUI | v0.5 | 支持 `/new`、`/resume`、`/rename`、`/quit`、Esc interrupt、working trace、context usage |
| Experiment Design Mode | 文档完成 | 代码未实现 |
| Execution Plan Mode | 文档完成 | 代码未实现 |
| Result Analysis Mode | 文档完成 | 代码未实现 |
| Writing / Revision Mode | 文档完成 | 代码未实现 |
| Multi-agent Harness | 文档完成，部分 runtime 雏形 | 尚未实现完整 controlled subagents / AC review fan-in |

准确地说，当前版本是：

```text
一个可运行的 Academic Agent v0 骨架
+ 一个初步可用的 Idea Plan 对话模式
+ 搜索工具、上下文管理和本地 artifact/trace 雏形
```

## 技术栈

- Runtime: Node.js 22+ + TypeScript + pnpm monorepo
- TUI: Ink + React (`apps/academic-agent`)
- Agent core: 自研 agent loop（`packages/agent-core`），非 LangGraph
- Storage: `.academic-agent/` local workspace，SQLite + files
- Schema: Zod（`packages/schemas`）
- Providers: mock、OpenAI、Anthropic、OpenAI-compatible、DeepSeek
- Search: arXiv、OpenAlex、Tavily、Brave、Serper、SerpAPI、DuckDuckGo

## 目录结构

```text
apps/academic-agent/      # Ink TUI + in-process core client
packages/agent-core/      # IdeaPlanRunner + agent loop
packages/workspace/       # SQLite persistence
packages/config/          # TOML + env
packages/harness/         # artifacts, memory, cache, traces
packages/providers/       # LLM adapters
packages/search/          # search + tools
packages/schemas/         # Zod contracts
packages/core-service/    # TUI-facing service layer
docs/                     # mode and architecture design docs
bin/academic-agent.mjs    # CLI entrypoint
.academic-agent/          # local workspace (mostly gitignored)
```

## 安装

### 1. Node.js 与 pnpm

需要 Node.js 22+ 和 pnpm 11：

```bash
corepack enable
corepack prepare pnpm@11.3.0 --activate
make install
```

`better-sqlite3` 需要本地编译；若测试报 native binding 错误，在仓库根目录执行：

```bash
cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npm run build-release
```

### 2. 开发 mock 模式

测试或本地开发可使用 mock provider：

```bash
export ACADEMIC_AGENT_ALLOW_MOCK=1
```

### 3. 启动

```bash
make schema
```

## 配置

项目配置在：

```text
.academic-agent/config.toml
```

本地密钥放在：

```text
.academic-agent/.env
```

可以从样例复制：

```bash
cp .academic-agent/.env.example .academic-agent/.env
```

常用配置：

```toml
[runtime]
core_host = "127.0.0.1"
core_port = 8765

[context.compaction]
context_window_tokens = 1000000
max_history_tokens = 200000
compact_trigger_ratio = 0.85

[providers.planner]
provider = "deepseek"
model = "deepseek-v4-pro"
api_key_env = "DEEPSEEK_API_KEY"
max_output_tokens = 30000

[search]
paper_sources = ["arxiv", "openalex"]
web_sources = ["brave", "tavily", "serper", "serpapi", "duckduckgo"]
```

启用真实 provider 调用时，在 `.academic-agent/.env` 里配置：

```bash
ACADEMIC_AGENT_ENABLE_LIVE_PROVIDERS=1
DEEPSEEK_API_KEY=...
TAVILY_API_KEY=...
```

不要把真实 key 写入 `config.toml`。

## 运行

### 推荐方式：CLI 自动启动 core

```bash
pnpm link --global
academic-agent
```

或在项目目录：

```bash
make dev
# 或
pnpm tui
```

CLI 为单进程 TypeScript 应用，不再依赖 Python/FastAPI。

### 指定项目根目录

```bash
ACADEMIC_AGENT_PROJECT_ROOT=/path/to/project academic-agent
```

```bash
pnpm --filter @academic-agent/app dev
```

## TUI 命令

```text
/new                 开启新对话
/new IDEA            用 IDEA 开启新对话
/resume              打开 session 列表
/resume NAME         按名称恢复 session
/rename              自动总结当前 session 标题
/rename NAME         手动重命名当前 session
/cache               查看 app cache
/clear-cache         清理 app cache
/quit                退出
Esc                  打断当前 run
```

TUI 会显示：

- 当前 provider/model
- session id/title
- context usage 和 compact threshold
- working trace，包括 planning、thinking、searching、observing、answering
- 最终 assistant 回复

## 测试与质量检查

常用检查：

```bash
make test
```

分开运行：

```bash
pnpm -r typecheck
pnpm test
```

## Git 忽略策略

`.gitignore` 会忽略：

- `.academic-agent/.env`
- SQLite 数据库
- artifacts、traces、cache、logs、memory runtime 输出
- Python/Node 缓存
- `node_modules/`、`.pnpm-store/`

保留：

- `.academic-agent/config.toml`
- `.academic-agent/.env.example`

这样可以提交项目配置和密钥样例，但不会提交真实密钥和本地运行记录。

## 已知限制

- 目前代码层面主要只有 `Idea Plan Mode`。
- 还没有真正的 frozen `ResearchIdeaPlan` gate。
- 还没有 paper PDF ingestion / mini-review artifact。
- 还没有完整 semantic retrieval、rehydrate、conflict record。
- 搜索工具已有 fallback 和 rate-limit cooldown，但还需要更严格的 search budget / stop rules。
- Experiment / Execution / Result Analysis / Writing 模式目前是设计文档，尚未接入 runtime mode graph。

## 下一步建议

优先推进 `Idea Plan Mode v1`：

1. 搜索结果 artifact 与 `/papers` 查看。
2. 关键论文 mini-review。
3. candidate idea review: `Reject / Revise / Advance`。
4. `/context` 与 `/artifact` 命令。
5. frozen `ResearchIdeaPlan`。
6. 再进入 `Experiment Design Mode` 的代码实现。
