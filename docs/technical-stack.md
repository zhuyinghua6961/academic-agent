# Academic Agent 技术栈与本地架构规范

## 1. 目标与架构原则

本规范定义 academic agent 第一版的技术栈、进程边界、模型接入、缓存、认证、本地存储和测试门禁。第一版采用 **local-first TUI**：用户主要通过终端使用系统，所有研究状态默认保存在本地项目工作区。

核心原则：

```text
TypeScript owns research intelligence and user experience.
Provider/cache/artifact contracts must be auditable and reproducible.
```

### 1.1 v1 范围

v1 是本地个人研究工具：

- 提供 TypeScript TUI。
- 提供 Python agent core。
- 支持 OpenAI 和 Anthropic。
- 支持本地项目工作区、artifact、trace、cache 和向量索引。
- 支持未来 Web 复用的 API、event 和 schema 契约。

v1 不做：

- 多用户 Web 平台。
- 团队权限、组织管理和账单系统。
- 云同步。
- 任意 provider 插件系统。
- Go / Java gateway 或企业平台服务。

Go 或 Java 只在未来出现 gateway、local daemon、企业权限、部署平台或组织级审计需求时再引入。

## 2. 总体架构

第一版分为两层：

```text
TypeScript Ink TUI (apps/academic-agent)
        |
        | in-process (core-service)
        v
TypeScript Agent Core (packages/*)
  - custom agent loop
  - Memory / context harness
  - Provider adapters
  - Artifact manager
  - Cache manager
  - Search / tools
        |
        v
Local Project Workspace
  - SQLite
  - files
```

### 2.1 技术选择

| 层 | 技术 | 选择理由 |
| --- | --- | --- |
| TUI | TypeScript + Ink + React | 适合构建现代 agent CLI，组件化、流式渲染和快捷键体验好 |
| Python runtime | Python 3.12+ | 学术工具链、LLM orchestration、PDF/embedding/eval 生态成熟 |
| Python package manager | uv | 依赖解析快，lockfile 清楚，适合工具型项目 |
| TS package manager | pnpm | workspace 管理和安装速度适合 monorepo |
| Local API | FastAPI | Python 类型系统和 OpenAPI 兼容好，方便未来 Web 复用 |
| Event stream | SSE | 适合 token、状态、checkpoint、usage 等单向流式事件 |
| Workflow | LangGraph | 支持 checkpoint、resume、interrupt 和 human-in-the-loop |
| Schema | Pydantic -> JSON Schema -> TS/Zod | Python core 拥有 artifact 权威 schema，TUI 生成类型和校验 |
| Metadata store | SQLite | 本地单文件、可审计、易备份 |
| Artifact files | filesystem | Markdown、LaTeX、PDF、logs 等需要可读可迁移 |
| Vector index | LanceDB | 本地嵌入式向量索引，适合论文 chunk 和 embedding |
| Config | TOML | 人工可编辑、注释友好，Python/TS 都易读 |

## 3. 工作区与目录约定

每个研究项目使用项目内工作区：

```text
project-root/
  .academic-agent/
    config.toml
    state.sqlite
    artifacts/
    traces/
    memory/
    cache/
    documents/
    lancedb/
    exports/
```

### 3.1 工作区职责

| 路径 | 内容 |
| --- | --- |
| `.academic-agent/config.toml` | 项目级配置，覆盖全局默认配置 |
| `.academic-agent/state.sqlite` | project、run、event、cache index、artifact metadata |
| `.academic-agent/artifacts/` | frozen / draft artifacts |
| `.academic-agent/traces/` | 模型请求、响应、usage、cache hit、checkpoint trace |
| `.academic-agent/memory/` | Project Memory Map、memory records、conflict records |
| `.academic-agent/cache/` | app result cache、解析缓存、检索 snapshot |
| `.academic-agent/documents/` | PDF、HTML snapshot、parsed text、chunks |
| `.academic-agent/lancedb/` | 本地向量索引 |
| `.academic-agent/exports/` | Manuscript Package、submission bundle 等导出结果 |

### 3.2 Artifact 不等于 Cache

以下 artifact 是正式研究证据，不作为普通 cache 清理：

- `ResearchIdeaPlan`
- `Experiment Blueprint`
- `Execution Package`
- `Result Analysis Report`
- `Manuscript Package`

普通 cache 可以清理、重建或过期；frozen artifact 只能通过版本化修改或明确废弃处理。

## 4. 配置规范

配置分两层：

```text
~/.academic-agent/config.toml          # 全局默认
project/.academic-agent/config.toml    # 项目覆盖
```

项目配置优先级高于全局配置。最终运行时配置必须写入 trace metadata，用于复现。

### 4.1 配置内容

```toml
[providers.openai]
auth = "env_or_keychain"
env_key = "OPENAI_API_KEY"

[providers.anthropic]
auth = "env_or_keychain"
env_key = "ANTHROPIC_API_KEY"

[profiles.planner]
provider = "openai"
model = "..."
temperature = 0.2

[profiles.reviewer]
provider = "anthropic"
model = "..."
temperature = 0.1

[profiles.writer]
provider = "openai"
model = "..."
temperature = 0.3

[profiles.extractor]
provider = "openai"
model = "..."
temperature = 0.0

[profiles.embedder]
provider = "openai"
model = "..."

[cache]
provider_prompt_cache = "static_blocks"
app_result_cache = true
retrieval_cache_ttl_days = 30

[privacy]
trace_mode = "full"  # full | metadata_only
```

具体模型名称属于配置值，不写死在 mode 文档中。模型变更必须进入 run metadata 和 cache key。

## 5. Python Core 与 LangGraph

Python core 拥有 academic agent 的研究智能、模式流转和 artifact 管理。

### 5.1 Workflow 结构

v1 直接使用 LangGraph：

```text
AcademicWorkflowGraph
  -> IdeaPlan node/subgraph
  -> ExperimentDesign node/subgraph
  -> ExecutionPlan node/subgraph
  -> ResultAnalysis node/subgraph
  -> WritingRevision node/subgraph
```

每个 mode 由自己的 schema、guardrails、review gate 和 frozen artifact 定义。LangGraph 负责：

- checkpoint。
- resume。
- interrupt。
- human-in-the-loop。
- mode backtrack。
- state snapshot。

Artifact freeze 规则不交给 LangGraph 隐式决定，而由 Python core 的 artifact manager 显式验证。

Memory、context、subagent handoff 和结构化 ReAct 行动轨迹由 `docs/memory-context-harness.md` 定义。该 harness 服务所有 mode，但不是新的研究 mode。

### 5.2 Thread 与 Run

每个项目可以有多个 workflow thread：

```text
Project
  -> Workflow Thread
      -> Mode Run
          -> Checkpoints
          -> Events
          -> Artifacts
          -> Traces
```

`thread_id` 是恢复 workflow 的主键。每个 `mode_run_id` 对应一次 mode 内部执行、讨论、冻结或回退过程。

## 6. TUI 与本地 API

TUI 使用 TypeScript + Ink + React。TUI 不直接调用 OpenAI、Anthropic 或本地数据库，只调用 Python local service。

### 6.1 本地 API 边界

Python FastAPI local service 暴露：

| 能力 | 说明 |
| --- | --- |
| Project / workspace init | 初始化 `.academic-agent/` |
| Project status | 查询当前项目、配置、artifact、run 状态 |
| Mode run create | 创建 mode run |
| Mode run pause/resume/cancel | 暂停、恢复、取消 |
| SSE event stream | 输出 token、状态、工具、artifact、usage、cache、error、checkpoint |
| Artifact CRUD | 读取、创建 draft、冻结、导出 |
| Provider profile check | 检查模型配置、key、capability |
| Cache inspect/clear | 查看和清理 cache |
| Document ingestion | 导入 PDF、arXiv、URL |
| Memory / context inspect | 查看 Memory Map、context preview、memory proposals 和 conflicts |

### 6.2 SSE Event 类型

SSE event 必须结构化。最低事件类型：

| Event | 用途 |
| --- | --- |
| `token.delta` | 模型输出增量 |
| `mode.status` | mode 状态变化 |
| `tool.event` | 工具调用、完成、失败 |
| `artifact.event` | artifact draft/update/freeze |
| `cache.hit` | provider/app/retrieval cache 命中 |
| `usage.report` | token、cost、latency、cache stats |
| `checkpoint.saved` | LangGraph checkpoint |
| `error` | 结构化错误 |

TUI 负责渲染，不负责解释模式规则。

Memory / context harness 会扩展事件类型，例如 `context.built`、`memory.proposal`、`memory.updated`、`conflict.detected`、`action.started`、`observation.summary`、`decision.made`、`agent.message.sent`、`agent.message.received`、`agent.handoff.completed`、`agent.fanout.started` 和 `agent.fanin.completed`。

## 7. Schema 与 Contract

Pydantic 是 schema 权威来源：

```text
Pydantic models
-> JSON Schema
-> TypeScript types
-> Zod validators
```

### 7.1 Schema 覆盖范围

必须 schema 化：

- academic artifacts。
- API request / response。
- SSE events。
- provider normalized request / response。
- trace metadata。
- cache records。
- memory records、context packets、handoff packets 和 conflict records。
- `AgentMessage`、`AgentCommunicationTrace`、`ReviewFanoutGroup` 和 `CommunicationBudget`。
- config profiles。
- structured errors。

### 7.2 版本策略

以下版本必须记录在 run metadata 中：

- `schema_version`
- `prompt_version`
- `tool_schema_version`
- `artifact_version`
- `provider_adapter_version`
- `model_profile_version`
- `retrieval_corpus_version`

任何影响输出语义的版本变化，都必须进入 cache key。

## 8. Provider Adapter

v1 支持 OpenAI 和 Anthropic。系统自建薄 adapter，不先引入任意 provider 插件协议。

### 8.1 Adapter 职责

Provider adapter 只负责 provider 差异：

- 认证。
- request translation。
- streaming normalization。
- usage normalization。
- prompt cache hints。
- provider request id。
- timeout / retry。
- structured errors。
- cost metadata。

Mode、artifact、review、写作和缓存策略不写进 provider adapter。

### 8.2 统一输出

Provider adapter 必须输出统一结构：

```markdown
- provider:
- model:
- model_version:
- request_id:
- normalized_content:
- stream_events:
- usage:
  - input_tokens:
  - output_tokens:
  - cached_input_tokens:
  - reasoning_tokens:
- latency_ms:
- cache:
  - provider_cache_read:
  - provider_cache_write:
- retryable:
- error:
```

字段不存在时使用 `null` 或明确的 unsupported 标记，不能静默丢失。

### 8.3 Provider 认证

OpenAI:

- 使用 API key。
- key 通过 HTTP Bearer authentication。
- key 必须从环境变量或 key management 读取。
- 不允许暴露到浏览器、trace、cache、artifact 或 git-tracked 文件。

Anthropic:

- 使用 `x-api-key` 或等价 bearer/token 方式。
- 请求必须包含 provider 要求的 version header。
- response request id 必须进入 trace metadata。

### 8.4 Provider 错误模型

错误必须归一化为：

| Error | 含义 |
| --- | --- |
| `auth_error` | key 缺失、无效或权限不足 |
| `rate_limited` | provider 限速 |
| `quota_exceeded` | 额度或预算不足 |
| `timeout` | 请求超时 |
| `server_error` | provider 侧错误 |
| `invalid_request` | 参数、model、tool schema 或 payload 错误 |
| `stream_error` | 流式输出中断 |
| `content_policy` | provider 内容策略拒绝 |

每个错误必须标注 `retryable` 和用户可读修复建议。

## 9. Auth 与 Secrets

v1 使用 local env/BYOK：

1. 优先读取环境变量。
2. 用户选择保存 key 时写入 OS keychain。
3. 项目配置只保存 provider/profile 引用，不保存 key 明文。

### 9.1 Secret 禁止进入的位置

API key 不得进入：

- `.academic-agent/config.toml`。
- trace 文件。
- cache key。
- artifact 文件。
- logs。
- git-tracked 文件。
- TUI 前端状态。

### 9.2 Trace 中允许记录

Trace 只能记录：

- provider。
- model。
- profile。
- key source: `env` / `keychain` / `missing`。
- organization/workspace id 的安全摘要，如果 provider 返回且不敏感。

## 10. 缓存设计

缓存分四层，不能混用。

### 10.1 Provider Prompt Cache

Provider prompt cache 用于降低延迟和成本，不作为复现证据。

默认策略：

- 静态块默认启用。
- 动态用户消息、工具结果和未冻结 artifact 谨慎缓存。
- 缓存命中与 provider usage 一起记录。

适合缓存的静态块：

- system prompt。
- tool schema。
- mode policy。
- 长论文全文或 chunk bundle。
- venue profile。
- frozen artifact 摘要。

OpenAI prompt caching 按 provider 规则自动工作，adapter 只负责稳定静态前缀、传递可用的 cache key / retention 参数，并记录 cached token usage。

Anthropic prompt caching 需要 adapter 标注 `cache_control`，默认使用短 TTL；只有明确稳定且可复用的内容才使用更长 TTL。

### 10.2 App Result Cache

App result cache 是 academic agent 自己维护的可审计缓存。

默认缓存：

- PDF parsing。
- arXiv / URL snapshot parsing。
- chunking。
- embedding。
- citation audit。
- paper mini-review。
- fixed artifact 输入下的 reviewer report。
- fixed artifact 输入下的 writer draft fragment。

Cache key 必须包含：

```text
provider
model
model_params
prompt_version
tool_schema_version
artifact_version
retrieval_corpus_version
input_hash
privacy_mode
```

任何一项变化都应导致 cache miss。

### 10.3 Retrieval Cache

联网检索必须保存：

- source URL。
- source type。
- query。
- retrieved_at。
- snapshot hash。
- TTL。
- parser version。
- source metadata。

`latest`、`current`、投稿状态、venue 规则、价格、模型能力等时间敏感查询必须重新验证，或在输出中明确标注查询日期。

### 10.4 Artifact Store

Artifact store 是研究证据层，不受普通 TTL 清理影响。Artifact freeze 后必须保留：

- schema version。
- source inputs。
- dependency artifact ids。
- model profile。
- prompt version。
- trace links。
- reviewer / gate decision。
- freeze timestamp。

## 11. Document Ingestion 与向量索引

v1 支持：

- 本地 PDF。
- arXiv metadata。
- URL 下载和 snapshot。

### 11.1 Ingestion Pipeline

```text
source
-> fetch / import
-> snapshot
-> parse
-> normalize metadata
-> chunk
-> embed
-> index in LanceDB
-> record provenance in SQLite
```

每个 chunk 必须可追溯：

- document id。
- source URL / file path。
- page / section。
- parser version。
- chunker version。
- embedding model。
- embedding timestamp。

### 11.2 文献状态

arXiv comments、OpenReview 状态、venue acceptance、DBLP/proceedings 信息可能变化。写作或 review 依赖这些状态时，必须保存 retrieved_at，并在需要 latest 时重新验证。

## 12. Trace、隐私与审计

默认 `trace_mode = "full"`，项目可切换 `metadata_only`。

### 12.1 Full Trace

Full trace 保存：

- normalized request。
- normalized response。
- model output。
- usage。
- provider request id。
- cache hit / miss。
- artifact references。
- prompt version。
- tool schema version。
- latency。
- error。

Full trace 用于复现、debug、review 和结果审计。

### 12.2 Metadata-only Trace

Metadata-only trace 保存：

- input hash。
- output hash。
- provider。
- model。
- usage。
- latency。
- artifact ids。
- cache status。
- error code。

Metadata-only 不保存完整 prompt、用户输入、论文私密内容或模型输出正文。进入 metadata-only 后，部分写作和结果审计能力会下降，agent 必须提示用户。

### 12.3 工作区加密

v1 不内置全工作区加密。默认依赖：

- OS 用户权限。
- 磁盘加密。
- OS keychain。
- metadata-only trace。

如果用户需要团队共享或云同步，应在后续版本重新设计加密、权限和审计模型。

## 13. Model Profiles

不同任务通过 profile 路由模型，不要求用户每次手选。

默认 profiles：

| Profile | 用途 | 输出要求 |
| --- | --- | --- |
| `planner` | idea / experiment / writing planning | 结构化、低温、可追溯 |
| `reviewer` | paper/idea/experiment/manuscript review | 严格、批判、带 confidence |
| `writer` | LaTeX / academic prose drafting | venue-aware、证据约束 |
| `extractor` | PDF/网页/结果表信息抽取 | 低温、schema-constrained |
| `embedder` | 文档 chunk embedding | 稳定、可批处理 |

每个 run 必须记录实际使用的 profile 展开结果：

- provider。
- model。
- model params。
- prompt version。
- cache policy。

## 14. Testing 与质量门禁

### 14.1 Contract Tests

- Pydantic schema 导出 JSON Schema。
- TS types / Zod validators 由 schema 生成。
- API fixtures 同时通过 Python 和 TS 校验。
- SSE event fixtures 覆盖所有事件类型。
- Memory / context / handoff fixtures 覆盖 context packet、memory proposal 和 conflict record。
- Multi-agent communication fixtures 覆盖 `AgentMessage`、`ReviewFanoutGroup`、AC fan-in、`CommunicationBudget` 和 stop rules。

### 14.2 Provider Tests

默认 CI 不调用真实 provider：

- mock stream。
- mock error。
- mock usage。
- mock cache stats。
- recorded fixtures。

Live tests 必须满足：

- 显式开启环境变量。
- 本机存在 provider key。
- 测试标记为 gated。
- 成本和速率受限。

### 14.3 Cache Tests

必须验证：

- 相同 immutable input 命中。
- prompt version 变化 miss。
- model/profile 变化 miss。
- artifact version 变化 miss。
- retrieval corpus version 变化 miss。
- metadata-only 与 full trace 不混用 cache。

### 14.4 Auth Tests

必须验证：

- env 优先级。
- keychain fallback。
- missing key 的用户提示。
- trace/log/artifact/cache 不泄露 secret。

### 14.5 Workflow Tests

必须验证：

- LangGraph checkpoint。
- resume。
- interrupt。
- human approval。
- mode backtrack。
- frozen artifact gate。

### 14.6 TUI Tests

必须验证：

- SSE event rendering。
- run cancel/resume。
- provider/profile error display。
- cache hit display。
- artifact freeze confirmation。

### 14.7 Ingestion Tests

必须验证：

- PDF import。
- arXiv metadata snapshot。
- URL snapshot。
- TTL refresh。
- chunk provenance。
- embedding index rebuild。

## 15. 未来 Web 化路径

v1 虽然是 local-first TUI，但 API 和 schema 必须按未来 Web 复用设计：

- FastAPI/OpenAPI 不绑定 TUI。
- SSE event schema 不包含终端 UI 语义。
- Pydantic schema 不依赖本地文件路径作为唯一身份。
- Artifact ids、run ids、thread ids 可迁移到 server-backed storage。
- Provider key 管理未来可替换为 server secret manager。

未来 Web 端建议：

```text
Web UI: TypeScript + React / Next.js
Backend: reuse Python FastAPI core first
Database: Postgres
Vector: managed LanceDB/Qdrant/pgvector, based on scale
Auth: user/workspace/org model
Secrets: server secret manager
```

Go / Java 仍不拥有 research intelligence。它们只在基础设施层有明确收益时引入。

## 16. 参考资料

- OpenAI API authentication: https://platform.openai.com/docs/api-reference/authentication
- OpenAI prompt caching: https://platform.openai.com/docs/guides/prompt-caching
- Anthropic API overview: https://docs.anthropic.com/en/api/overview
- Anthropic prompt caching: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- LangGraph persistence: https://docs.langchain.com/oss/python/langgraph/persistence
