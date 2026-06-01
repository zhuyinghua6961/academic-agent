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
| Foundation Skeleton | 可运行 | TypeScript TUI + FastAPI core + LangGraph single-mode graph + SQLite/files workspace |
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

- TUI: TypeScript + Ink + React + pnpm
- Core: Python 3.12+ + FastAPI + LangGraph + Pydantic
- API/Event: FastAPI + SSE
- Storage: `.academic-agent/` local workspace，SQLite 存 metadata/event/thread/cache，files 存 artifact/trace/memory
- Schema: Pydantic 为源，导出 JSON Schema 和 TypeScript types
- Providers: mock、OpenAI、Anthropic、OpenAI-compatible、DeepSeek
- Search: arXiv、OpenAlex、Tavily、Brave、Serper、SerpAPI、DuckDuckGo

## 目录结构

```text
apps/tui/                 # Ink TUI
services/core/            # FastAPI + LangGraph core
packages/schemas/         # generated schema/types
scripts/export_schema.py  # Pydantic -> JSON Schema / TS types
docs/                     # mode and architecture design docs
bin/academic-agent.mjs    # local CLI wrapper, can auto-start core
.academic-agent/          # local workspace, mostly ignored by git
```

## 安装

### 1. 创建 Python 环境

推荐使用 conda：

```bash
conda create -n academic-agent python=3.12 -y
conda activate academic-agent
```

安装 Python 依赖：

```bash
pip install -r requirements.txt
```

或者直接用 Makefile：

```bash
make install
```

### 2. 安装 pnpm 和 TypeScript 依赖

如果本机没有 pnpm：

```bash
corepack enable
corepack prepare pnpm@11.3.0 --activate
```

安装 workspace 依赖：

```bash
pnpm install
```

### 3. 生成 schema

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

`academic-agent` 会读取 `.academic-agent/config.toml` 的端口配置，并尝试自动启动/释放本机 core。

### 开发方式：分开启动 core 和 TUI

终端 1：

```bash
make dev-core
```

终端 2：

```bash
make dev-tui
```

也可以指定 core URL：

```bash
pnpm --filter @academic-agent/tui dev -- --core-url http://127.0.0.1:8765
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
make schema
make test-python
make typecheck
conda run -n academic-agent env PYTHONNOUSERSITE=1 python -m ruff check services/core/src services/core/tests
conda run -n academic-agent env PYTHONNOUSERSITE=1 python -m mypy services/core/src/academic_agent_core
```

当前主要回归测试集中在：

```text
services/core/tests/test_foundation_slice.py
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
