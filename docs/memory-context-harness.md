# Memory / Context / Multi-Agent Harness 架构规范

## 1. 目标与边界

`Memory / Context / Multi-Agent Harness` 是 academic agent 的底层运行时规范。它不是第六个研究 mode，而是服务所有研究 mode 的共享 harness：

```text
Idea Plan Mode
Experiment Design Mode
Execution Plan Mode
Result Analysis Mode
Writing / Revision Mode
```

核心设计：

```text
LangGraph Mode Graph
-> controlled subagents
-> Context Builder
-> Project Memory Map
-> Artifact / Document / Vector / Trace stores
-> structured ReAct event trace
-> memory update gates
```

它的目标是让 agent：

- 不忘记关键研究决策。
- 不把完整历史塞进上下文。
- 不让 subagent 互相污染上下文。
- 不把过期信息当当前事实。
- 能跨天恢复研究状态。
- 能审计为什么读了某个文件、调用了某个工具、更新了某条记忆。
- 能通过测试证明记忆和上下文系统有效。

### 1.1 非目标

- 不定义新的研究流程；研究流程仍由五个 mode 文档定义。
- 不让多个 agent 自由聊天或自由改 artifact。
- 不把向量库当成唯一记忆系统。
- 不暴露模型原始 hidden chain-of-thought。
- 不让长期记忆自动覆盖 frozen artifact 或历史决策依据。

## 2. Multi-Agent 架构

Academic agent 采用 `Mode Graph + Subagents`，不采用自由 swarm。

### 2.1 顶层 Mode Graph

顶层由 LangGraph 管理：

```text
AcademicWorkflowGraph
  -> IdeaPlan subgraph
  -> ExperimentDesign subgraph
  -> ExecutionPlan subgraph
  -> ResultAnalysis subgraph
  -> WritingRevision subgraph
```

Mode graph 负责：

- mode 进入、暂停、恢复和回退。
- checkpoint。
- human-in-the-loop interrupt。
- artifact freeze gate。
- trace 和事件流。

### 2.2 受控 Subagents

每个 mode 内可调用专业 subagent：

| Mode | Subagents 示例 |
| --- | --- |
| `Idea Plan Mode` | `Paper Reader`, `Research Mentor`, `Novelty Reviewer` |
| `Experiment Design Mode` | `Experiment Architect`, `Baseline Reviewer`, `Metric Reviewer` |
| `Execution Plan Mode` | `Research Engineer`, `Reproducibility Guard` |
| `Result Analysis Mode` | `Result Auditor`, `Statistic Reviewer`, `Error Analyst` |
| `Writing / Revision Mode` | `Writer`, `Novelty Reviewer`, `Soundness Reviewer`, `AC` |
| Runtime harness | `Memory Librarian`, `Context Builder`, `Tool Router` |

Subagent 是受控角色，不是独立自治项目成员。它们只能在授权 mode、授权任务和授权工具范围内工作。

### 2.3 Subagent 最小权限

默认规则：

- 只接收 `Handoff Packet`，不共享完整聊天历史。
- 只调用当前任务授权的工具。
- 只输出结构化 report、proposal 或 review。
- 不能直接修改 frozen artifact。
- 不能直接覆盖长期 memory。
- 不能绕过 mode gate 或 human approval。

如果某个 subagent 需要更高权限，必须在 mode schema 或 tool policy 中显式声明，并进入 trace。

## 3. Multi-Agent Communication Protocol

多 agent 通信不是自然语言互聊，而是由 mode agent / LangGraph runtime 中介的结构化协议。默认拓扑是 `Supervisor-mediated`：subagent 之间不直接发自由消息，也不共享完整聊天历史。

```text
Mode Agent / Graph Runtime
  -> sends Handoff Packet
  -> receives structured report/proposal
  -> validates schema and permissions
  -> records trace
  -> decides artifact/memory/state update
```

### 3.1 通信拓扑

默认规则：

- 所有 subagent 通信都经过当前 mode agent 或 LangGraph runtime。
- subagent 不直接调用其他 subagent。
- subagent 不直接写 shared state、frozen artifact 或 long-term memory。
- peer-to-peer handoff 只有在 graph 中显式建模时才允许，并且仍必须通过 `Handoff Packet`、permission gate 和 trace。
- 禁止 free peer messaging 和 free swarm。

这种设计牺牲一部分灵活性，但换来责任边界、上下文隔离和审计能力。

### 3.2 Control / Data / Event 三层通道

多 agent 通信分三层：

| Channel | 内容 | 用途 | 是否作为 agent 决策源 |
| --- | --- | --- | --- |
| `Control Channel` | LangGraph state、route、checkpoint、handoff control | 决定谁接棒、是否暂停、是否回退 | yes |
| `Data Channel` | `Context Packet`、`Handoff Packet`、report、proposal、review | 传递证据、任务和结构化产出 | yes |
| `Event Channel` | SSE events、TUI 展示、trace notification | 告诉用户和 trace 系统发生了什么 | no |

`Event Channel` 不能反向驱动 agent 决策。TUI 看到的事件只是可视化和审计输出，不是 shared state。

### 3.3 AgentMessage Envelope

所有 agent 间消息都使用统一 envelope：

```markdown
# AgentMessage

## Identity
- Message ID:
- Thread ID:
- Mode Run ID:
- Trace ID:
- Parent Message ID:

## Route
- Sender:
- Receiver:
- Supervisor:
- Channel: [control / data / event]
- Message Type:

## Payload
- Payload Schema:
- Payload:
- Source Refs:
- Artifact Refs:
- Context Packet Ref:

## Status
- Status: [created / sent / received / validated / rejected / completed / failed]
- Confidence:
- Retry Count:
- Created At:
- Completed At:

## Safety
- Permissions Used:
- Privacy Mode:
- Redaction Applied:
- Validation Errors:
```

Envelope 负责路由、审计和恢复；payload 负责具体业务内容。

### 3.4 Message Types

核心消息类型：

| Type | Sender | Receiver | Payload |
| --- | --- | --- | --- |
| `handoff.request` | mode agent | subagent | `Handoff Packet` |
| `handoff.result` | subagent | mode agent | structured report/proposal |
| `review.report` | reviewer subagent | AC / mode agent | reviewer report |
| `artifact.proposal` | subagent | mode agent / artifact manager | artifact change proposal |
| `memory.proposal` | Memory Librarian / subagent | memory manager / user gate | memory update proposal |
| `conflict.notice` | context builder / memory librarian | mode agent | conflict summary |
| `decision.record` | mode agent / AC | trace / artifact manager | decision and rationale |
| `error.report` | any component | mode agent / graph runtime | structured error |

每种 message type 必须有 Pydantic schema、validation policy 和 trace representation。

### 3.5 Proposal-only Shared State

Subagent 只能提交 proposal，不直接修改共享状态。

允许：

- 提交 `review.report`。
- 提交 `artifact.proposal`。
- 提交 `memory.proposal`。
- 提交 `conflict.notice`。
- 提交 `error.report`。

禁止：

- 直接修改 frozen artifact。
- 直接覆盖 long-term memory。
- 直接变更 mode state。
- 直接改变用户偏好。
- 直接删除 trace 或 source reference。

写入动作只能由 mode agent、artifact manager、memory manager 或 human gate 执行。

### 3.6 Review Fan-out / AC Fan-in

v1 默认只允许 review 类任务并行。典型模式：

```text
Mode Agent
-> fan-out to Reviewer A / Reviewer B / Reviewer C
-> collect review.report
-> AC Aggregator fan-in
-> AC meta-review
-> decision.record
```

规则：

- fan-out subagents 彼此不共享输出，避免互相影响。
- 每个 reviewer 使用相同或明确差异化的 `Handoff Packet`。
- AC Aggregator 只读 reviewer reports、source refs 和必要 artifact。
- AC 输出 meta-review、分歧处理、修改优先级、是否 backtrack。
- AC 不能把 review 分歧静默压平；必须记录 disagreement 和 resolution。

读论文、写作、实验设计等任务默认由 mode agent 串行组织。只有明确独立、可合并、可审计的任务才允许并行。

### 3.7 Failure / Retry / Escalation

失败处理采用 `Retry then Escalate`。

可有限重试：

- schema invalid。
- transient provider error。
- tool timeout。
- recoverable retrieval failure。
- malformed but repairable output。

不可无限重试。重试失败后必须返回 `error.report`：

```markdown
# Error Report

- Error Code:
- Retryable:
- Retry Count:
- Failed Component:
- Failed Message:
- Partial Output:
- Suggested Recovery:
- Escalation Target:
```

不允许在无 trace 的情况下自动换模型、自动降低任务标准或循环调用其他 subagent。

### 3.8 Budget 与 Stop Rules

每个 mode run 必须有 communication budget：

| Budget | 用途 |
| --- | --- |
| Handoff Depth | 限制连续 handoff 深度 |
| Review Rounds | 限制 review/revision 循环次数 |
| Tool Calls | 限制工具调用数量 |
| Cost | 限制 token/API 成本 |
| Latency | 限制单轮和总耗时 |
| Retry Count | 限制失败重试次数 |

触发 stop rule 时，agent 必须停止自动推进并升级：

- 超过 budget。
- 连续 schema validation 失败。
- reviewer 分歧无法被 AC 解决。
- artifact proposal 需要用户确认。
- memory conflict 影响 high-impact decision。
- provider/tool 失败影响 claim 或证据链。

升级目标可以是用户、当前 mode gate、上游 mode 或 error recovery flow。

### 3.9 Communication Trace Policy

默认 full local trace 保存：

- `handoff.request`。
- `handoff.result`。
- `review.report`。
- `artifact.proposal`。
- `memory.proposal`。
- `conflict.notice`。
- `decision.record`。
- `error.report`。

Metadata-only 项目只保存：

- message metadata。
- payload hash。
- source refs。
- artifact refs。
- decision summary。
- error code。

Metadata-only 模式下，agent 必须提示：后续 debug、review reconstruction 和 exact reproduction 能力会下降。

## 4. Harness Engineering

Harness 是让 agent 成为可恢复、可审计、可测试系统的运行时外壳。它优先于 prompt/persona 打磨。

### 4.1 Harness 组件

| 组件 | 职责 |
| --- | --- |
| Graph Runtime | 运行 LangGraph mode graph、checkpoint、resume、interrupt |
| Context Builder | 构造最小 `Context Packet` |
| Memory Manager | 读取、写入、检索、过期和冲突处理 |
| Memory Librarian | 提出 memory update proposal，不直接写入高风险 memory |
| Tool Registry | 管理工具 schema、权限、超时、错误和 fallback |
| Permission Gate | 控制外部检索、付费 API、文件访问、artifact freeze |
| Artifact Manager | 管理 draft/frozen artifacts 和版本关系 |
| Trace Recorder | 记录 context sources、actions、observations、decisions、errors |
| Eval Harness | 评测记忆命中、抗干扰、上下文一致性和 subagent 隔离 |

### 4.2 必须记录的行动

所有关键行动都必须进入 trace：

- context sources。
- retrieval query。
- selected / excluded context。
- tool call。
- observation summary。
- decision。
- artifact draft/update/freeze。
- memory proposal。
- memory update。
- conflict detection。
- error / retry / fallback。

Trace 必须记录结构化摘要和 source reference。敏感项目可使用 metadata-only trace，但 agent 必须说明审计能力会下降。

## 5. ReAct 行动轨迹规范

ReAct 在本系统中是工具调用和外部观察的行动循环，不是用户可见的完整思维链。

### 5.1 内部行动循环

```text
Task
-> Context Packet
-> Plan Summary
-> Action
-> Observation
-> Decision
-> Artifact / Memory Proposal
-> Trace
```

### 5.2 TUI 可见事件

TUI 展示结构化事件流：

| Event | 说明 |
| --- | --- |
| `plan.summary` | 当前任务计划摘要 |
| `context.built` | 本轮上下文包构造完成 |
| `action.started` | 工具调用或子任务开始 |
| `observation.summary` | 工具结果或检索结果摘要 |
| `decision.made` | 关键判断或路由决策 |
| `artifact.event` | artifact 更新或冻结 |
| `memory.proposal` | memory 更新提案 |
| `conflict.detected` | 新旧证据冲突 |
| `error` | 结构化错误 |

不得展示模型原始 hidden chain-of-thought。需要解释时，输出 `Decision Rationale`，即基于证据和规则的可审计理由。

## 6. Project Memory Map

`Project Memory Map` 是长期记忆入口，不替代向量库。它是一个可读、可版本化的项目导航图，用于告诉 agent 应该先看哪里。

建议路径：

```text
.academic-agent/memory/project-memory-map.md
```

### 6.1 Memory Map 模板

```markdown
# Project Memory Map

## Current Research State
- Active Idea:
- Current Mode:
- Current Thread:
- Frozen Artifacts:
- Draft Artifacts:
- Open Questions:
- Blocking Risks:

## Where to Look
| Need | Source | Why | Freshness |
| --- | --- | --- | --- |
| 当前主 claim | artifacts/research-idea-plan.md | frozen idea | stable |
| novelty risk | memory/related-work-map.md | 近邻论文和风险 | needs recheck |
| 实验 claim-evidence | artifacts/experiment-blueprint.md | 实验蓝图 | stable |
| 失败实验 | artifacts/execution-package.md | run logs | stable |
| 写作边界 | artifacts/result-analysis-report.md | 可信结果 | stable |

## Important Decisions
| Decision | Date | Source | Still Valid | Notes |
| --- | --- | --- | --- | --- |

## Do Not Forget
-

## User / Project Preferences
| Preference | Source | Confirmed | Scope |
| --- | --- | --- | --- |

## Stale / Needs Recheck
| Item | Reason | Last Checked | Recheck Trigger |
| --- | --- | --- | --- |

## Conflicts
| Conflict | Sources | Status | Required Action |
| --- | --- | --- | --- |
```

### 6.2 Memory Map 使用规则

- 每个 mode step 前，Context Builder 应先读取 Memory Map。
- Memory Map 只负责导航，不应承载长篇原文。
- Memory Map 中的 source 必须指向 artifact、document、trace 或 memory record。
- Memory Map 不能覆盖 frozen artifact 的内容。
- Memory Map 中的 stale 项不能作为当前事实直接使用。

## 7. Memory 分层

长期记忆分为六层：

| 层 | 内容 | 用途 |
| --- | --- | --- |
| `Project Memory Map` | 可读导航图 | 指引 agent 看哪里 |
| `Artifact Store` | frozen/draft artifacts | 正式研究证据 |
| `Document Store` | PDF、URL snapshot、parsed text、chunks | 原始和解析材料 |
| `Vector / Hybrid Index` | LanceDB + metadata filter | 语义检索和片段召回 |
| `Episodic Trace` | 讨论、决策、失败路径、review 分歧 | 恢复过程和解释历史 |
| `Conflict Records` | 新旧证据冲突 | 防止静默覆盖 |

### 7.1 向量化不是记忆本体

向量索引用于找相关片段，但不能替代：

- frozen artifact。
- 用户确认的偏好。
- 历史决策依据。
- 冲突记录。
- stale 标记。

检索结果必须带 source、timestamp、confidence 和 freshness。

## 8. Context Builder

`Context Builder` 负责把当前任务转成最小、可审计、可追溯的 `Context Packet`。

在 academic agent 中，`Context Packet` 默认是 artifact-centered 的最小证据包，也可称为 `Artifact Context Packet`：它以当前 mode 的 artifact、决策日志和必要原文片段为核心，而不是完整聊天历史。

### 8.1 主动检索

每个 mode step 前主动构造上下文：

1. 读取 `Project Memory Map`。
2. 确认当前 mode、task、artifact 状态和 open questions。
3. 选择必须读取的 artifact。
4. 使用 metadata filter 和向量检索找相关片段。
5. 排除不相关或 stale context。
6. 生成 `Context Packet`。
7. 在 TUI 展示检索摘要。

### 8.2 被动检索

用户提到以下内容时触发被动检索：

- “之前那个 idea”。
- “上次 review”。
- 某篇论文、作者、arXiv id 或 venue。
- 某个实验、图表、失败结果。
- 导师/合作者反馈。
- 被 reject 或 backtrack 的旧版本。

被动检索后，如果发现当前上下文不足，应先补全 context packet，再回答。

### 8.3 Context Packet 模板

```markdown
# Context Packet

## Task
- Mode:
- Mode Run:
- User Request:
- Immediate Goal:

## Required Artifacts
| Artifact | Version | Status | Why Included |
| --- | --- | --- | --- |

## Retrieved Evidence
| Source | Excerpt / Summary | Relevance | Freshness | Risk |
| --- | --- | --- | --- | --- |

## Decision History
| Decision | Source | Still Valid | Impact |
| --- | --- | --- | --- |

## Constraints
- User Constraints:
- Mode Constraints:
- Evidence Constraints:
- Privacy Constraints:

## Risks
- Missing Context:
- Stale Information:
- Conflicts:

## Excluded Context
| Source | Reason Excluded |
| --- | --- |
```

### 8.4 上下文预算

Context Builder 必须优先级排序：

1. 当前 task 必须的 frozen artifact。
2. 直接相关的 draft artifact。
3. 最新且可信的 decision log。
4. 与 claim、paper、experiment 直接相关的原文片段。
5. 用户显式提到的历史内容。
6. 背景性材料。

如果预算不足，应保留 source links 和摘要，并说明被排除的上下文。

### 8.5 双层 Smart Compact

聊天历史不能按固定条数机械截断。v1 采用双层 compact：

```text
Layer 1: per-call Context Packet
  -> 最近原文 transcript
  -> 当前 task 相关的高价值旧片段
  -> 压缩后的旧历史摘要

Layer 2: persistent Conversation Summary
  -> 写入 .academic-agent/memory/conversation-summaries/{thread_id}.md/.json
  -> 带 source refs、覆盖消息数、覆盖到的 ordinal
```

触发条件由预算而不是单一消息数决定：

- 估算历史 token 超过 `compact_threshold_tokens`。
- 用户或测试显式设置的 recent message / char window 被超过。
- 当前模型窗口、输出预算、system/tool 预算和 `max_history_tokens` 共同决定可用历史预算。
- `compact_threshold_tokens = history_token_budget * compact_trigger_ratio`，默认比例可在 `config.toml` 中调整。

Context Builder 在 compact 时必须记录：

- `context_focus`: 根据当前用户输入识别的任务焦点，如 `idea_plan`、`literature`、`experiment`、`execution`、`memory`。
- `estimated_history_tokens` 与 `history_token_budget`。
- `context_window_tokens` 与 `compact_threshold_tokens`。
- `recent_token_budget`、`important_token_budget`、`summary_token_budget`。
- `important_source_refs`: 被保留为原文片段的旧消息引用。
- `compact_reason`: 为什么本轮触发 compact。

高价值旧片段优先保留：

- 用户明确约束、纠正、决定和偏好。
- frozen artifact、claim、baseline、ablation、novelty、review、失败结论等研究关键内容。
- 与当前 `context_focus` 直接相关的历史消息。
- unresolved question、错误、回退、权限和安全相关信息。

摘要是有损的，不能被当成唯一事实来源。若用户的问题依赖被压缩细节，agent 应通过 trace、artifact、memory 或检索重新取回原文。

TUI 应展示当前对话的估算 token 使用情况，包括 thread history、draft input、模型 context window 和 compact threshold。该估算来自本地 tokenizer policy 或 `chars_per_token` 近似值，不等同于 provider 返回的真实 billing usage；provider usage 仍应通过 response usage 单独记录。

## 9. Handoff Packet

Subagent 不接收完整上下文，只接收 `Handoff Packet`。

```markdown
# Handoff Packet

## Role
- Subagent:
- Authorized Mode:
- Task:

## Input Context
- Context Packet Reference:
- Included Evidence:
- Excluded / Forbidden Context:

## Tool Permissions
| Tool | Allowed | Limits |
| --- | --- | --- |

## Output Contract
- Expected Schema:
- Decision Labels:
- Required Confidence:

## Boundaries
- Cannot Modify:
- Must Escalate If:
- Must Cite Sources:
```

Subagent 输出必须进入 trace，并由 mode agent 或 artifact manager 决定是否写入 artifact。

## 10. Memory 写入规则

记忆写入采用分级门禁。

### 10.1 自动写入

低风险、可追溯内容可自动写入：

- artifact metadata。
- artifact dependency。
- decision logs。
- paper metadata。
- retrieval snapshot。
- trace summary。
- tool failure summary。
- frozen artifact index。

自动写入必须带 source、timestamp 和 schema version。

### 10.2 需要用户确认

以下内容必须经用户确认：

- 用户长期偏好。
- 研究品味。
- 导师/合作者反馈。
- “我们相信 X 是创新点”这类高影响判断。
- 对未来工作方向有长期影响的约束。
- 删除、废弃或覆盖重要 memory。

### 10.3 必须 TTL / Stale 标记

以下内容必须有 TTL 或 stale 标记：

- venue rules。
- paper acceptance/status。
- model capability。
- API behavior。
- benchmark leaderboard / SOTA。
- 法规、价格、服务条款、工具版本。

Stale 信息不能直接作为当前事实；agent 必须重新验证或说明查询日期。

### 10.4 Memory Librarian

`Memory Librarian` 负责：

- 发现值得写入的 memory。
- 生成 memory update proposal。
- 标记 stale。
- 发现 conflict。
- 更新 Memory Map 的候选补丁。

它不能：

- 直接修改 frozen artifact。
- 直接覆盖 high-impact memory。
- 把未经确认的用户偏好写成长期事实。
- 把 stale 信息当当前事实。

## 11. Conflict 处理

新证据与旧 memory、decision 或 artifact 冲突时，创建 `Conflict Record`，不静默覆盖。

### 11.1 Conflict Record 模板

```markdown
# Conflict Record

## Conflict
- Type: [Memory / Artifact / Paper Status / Venue Rule / Result / User Preference]
- Detected At:
- Detected By:

## Existing Claim / Memory
- Source:
- Content:
- Timestamp:

## New Evidence
- Source:
- Content:
- Retrieved At:
- Confidence:

## Impact
- Affected Mode:
- Affected Artifact:
- Severity: [Minor / Major / Fatal]

## Required Action
- Action: [Update Memory / Recheck Source / Return to Mode / Ask User / Ignore]
- Owner:
- Deadline / Trigger:

## Resolution
- Status: [Open / Resolved / Superseded]
- Decision:
- Source:
```

### 11.2 冲突后果

冲突可导致：

- 更新 Memory Map。
- 更新 memory record。
- 回到 `Idea Plan Mode`。
- 补读论文。
- 重新审查 artifact。
- 标记旧判断为 superseded。

旧结论必须保留 source 和时间，便于理解当时为什么做出该决策。

## 12. Schema / API / Events

### 12.1 Schema

新增 schema：

- `ProjectMemoryMap`
- `MemoryRecord`
- `MemoryUpdateProposal`
- `ContextPacket`
- `HandoffPacket`
- `ConflictRecord`
- `StructuredActionTrace`
- `AgentMessage`
- `AgentCommunicationTrace`
- `ReviewFanoutGroup`
- `CommunicationBudget`

这些 schema 由 Pydantic 定义，导出 JSON Schema，再生成 TS/Zod 类型。

### 12.2 本地 API

FastAPI local service 增加能力：

| API 能力 | 用途 |
| --- | --- |
| memory inspect | 查看 Memory Map 和 memory records |
| context preview | 预览下一步将读取哪些上下文 |
| memory proposal accept/reject | 接受或拒绝 memory update proposal |
| conflict list | 查看 open conflicts |
| stale recheck | 重新验证 stale 信息 |
| context source explain | 解释为什么读取某个 source |

### 12.3 SSE Events

新增 SSE events：

| Event | 用途 |
| --- | --- |
| `context.built` | 上下文包构造完成 |
| `memory.proposal` | 新 memory 更新提案 |
| `memory.updated` | memory 已写入 |
| `conflict.detected` | 检测到新旧证据冲突 |
| `action.started` | ReAct action 开始 |
| `observation.summary` | observation 摘要 |
| `decision.made` | 决策完成 |
| `agent.message.sent` | agent message 已发送 |
| `agent.message.received` | agent message 已接收 |
| `agent.handoff.completed` | handoff 已完成 |
| `agent.fanout.started` | review fan-out 开始 |
| `agent.fanin.completed` | AC fan-in 完成 |

## 13. Evaluation

Memory / context / harness 必须单独评测，不能只看最终论文或最终回答。

### 13.1 评测维度

| 维度 | 检查问题 |
| --- | --- |
| Memory Hit | 是否找回关键历史决策 |
| Anti-distraction | 是否拒绝无关文档和旧噪声 |
| Conflict Detection | 是否发现新论文、新结果或新规则与旧记忆冲突 |
| Artifact Consistency | 是否保持 claim、实验、结果、写作边界一致 |
| Staleness Handling | 是否避免把过期 venue/paper/model 信息当当前事实 |
| Subagent Isolation | subagent 是否只看授权 context |
| Communication Integrity | agent message 是否通过 schema、权限和 trace 校验 |
| Trace Completeness | 是否能解释读取、行动、决策和写入 |

### 13.2 Regression Fixtures

必须建立回归场景：

- 跨天恢复同一 idea。
- 用户修改旧 idea。
- 新论文覆盖旧 novelty 判断。
- venue 规则更新。
- 写作时尝试引用未审计结果。
- 多 subagent 同时 review，但上下文隔离。
- Memory Map 指向 stale source。
- 用户偏好和当前任务冲突。
- metadata-only trace 下的能力降级。
- reviewer fan-out / AC fan-in。
- malformed agent message。
- handoff depth 超预算。
- subagent 试图直接写 artifact。

### 13.3 Release Gates

发布前必须通过：

- Context Packet contract tests。
- Handoff Packet permission tests。
- Memory update gate tests。
- Conflict Record tests。
- stale recheck tests。
- ReAct event trace tests。
- subagent isolation tests。
- multi-agent communication fixtures。
- communication budget / stop rule tests。

## 14. 与技术栈文档的关系

`docs/technical-stack.md` 定义 local-first TUI、FastAPI、LangGraph、Pydantic、SQLite、LanceDB、trace 和 provider adapter。本文档定义这些技术如何组成 memory/context/multi-agent harness。

实现时：

- Memory schema 归入 Pydantic schema 层。
- Memory files 归入 `.academic-agent/memory/`。
- Context / memory / ReAct events 归入 SSE event schema。
- AgentMessage、fan-out/fan-in 和 communication budget 归入 Pydantic schema 层。
- Memory evaluation 归入测试和 release gate。

## 15. 参考资料

- LangGraph handoffs: https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs
- ReAct paper: https://arxiv.org/abs/2210.03629
- LangGraph memory: https://docs.langchain.com/oss/python/langgraph/memory
- LangGraph overview: https://reference.langchain.com/python/langgraph/overview
