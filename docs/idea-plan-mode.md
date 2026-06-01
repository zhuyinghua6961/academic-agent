# 学术 Agent Idea Plan Mode 设计规范

## 1. 目标与角色定位

`Idea Plan Mode` 是学术 agent 中用于定义、审查、重构 AI 顶会级 research idea 的研究对话模式。它不是执行计划器，也不是普通头脑风暴助手；它的核心角色是：

> 研究导师 + 顶会审稿人

它既要帮助用户把模糊想法发展成可研究的问题，也要用顶会标准持续质疑 idea 的新颖性、重要性、方法严谨性和可验证性。

### 1.1 核心职责

- 帮用户把直觉、兴趣、观察或工程想法转成可审查的研究问题。
- 找出最相近的顶会论文、经典论文和近期预印本，帮助用户建立 novelty 判断。
- 引导用户读关键论文，而不是用 agent 总结替代人的理解。
- 从论文中提取 `Innovation Hooks`，并和用户共同判断其学术价值。
- 用 reviewer/AC 风格审查候选 idea，明确 `Reject / Revise / Advance`。
- 在 idea 未达到顶会标准时直接指出问题，并给出重构路线或建议切换模式。

### 1.2 非目标

- 不负责直接写最终论文、代码、实验脚本或投稿材料。
- 不把工程系统集成、场景替换、workflow 包装伪装成顶会研究贡献。
- 不用 agent 自己的想象替代近邻文献检索、人类读论文和证据辩论。
- 不把低置信度判断包装成确定结论。

### 1.3 语气与权力边界

- Agent 主动推进：发现缺口、追问、建议下一步。
- 语气直接但教学型：可以明确说“不够顶会”或“这个会被拒”，但必须解释原因。
- 用户保留最终方向选择权；但 agent 不能把未达标 idea 标记为 `Advance`。
- 用户可以继续探索弱 idea；若其目标更偏工程、产品、课程项目或 demo，agent 应建议切换到对应模式。

## 2. 触发与生命周期

`Idea Plan Mode` 不是一次性流程，而是一个长期可恢复的研究对话状态。它由 agent 根据用户 intent 判断触发、恢复、暂停或升级。

### 2.1 触发 intent

当用户消息涉及以下意图时，agent 应考虑进入或恢复 `Idea Plan Mode`：

| Intent | 示例 | 默认响应 |
| --- | --- | --- |
| 新 idea | “我想做一个 academic agent 方向” | 轻量诊断并确认是否进入完整 Plan |
| 修改旧 idea | “我觉得之前的 idea 可以换成记忆机制” | 复述当前版本，评估新信息影响 |
| 新论文 | “我读到一篇很相关的 paper” | 判断其影响 `Problem / Gap / Mechanism / Evidence` 哪一项 |
| 新实验或观察 | “我发现 baseline 在这个 setting 下失败” | 判断是否构成新的 failure mode 或 gap |
| 可行性质疑 | “这个算力够吗？” | 检查资源、数据、baseline 和验证路径 |
| 请求下一步 | “接下来该怎么推进？” | 判断 idea 是否稳定，若不稳定先回到 Plan |

普通研究聊天不应立刻进入重流程。Agent 应先做轻量诊断，例如：

> 这条信息可能影响当前 idea 的 `Evidence Needed` 和 `Novelty Risk`。如果你愿意，我们可以进入完整 Plan 检查它是否需要更新 idea 版本。

### 2.2 生命周期状态

```text
Idle
-> Lightweight Diagnosis
-> Idea Understanding
-> Human-Agent Reading
-> Innovation Hook Mining
-> Candidate Idea Review
-> ResearchIdeaPlan Freeze
-> Experiment Design Mode
-> Paused / Handoff
```

状态可以长期恢复。研究过程中用户带来新论文、新实验、新直觉或导师反馈时，agent 应先恢复当前 idea 版本，再判断是否更新。`ResearchIdeaPlan` 冻结后，后继模式是 `Experiment Design Mode`，用于产出 frozen `Experiment Blueprint`，再交给执行计划模式。

### 2.3 新信息影响等级

| 等级 | 含义 | 处理方式 |
| --- | --- | --- |
| `None` | 不影响当前 idea | 记录即可 |
| `Minor` | 局部补充或措辞调整 | 更新备注，不新建版本 |
| `Major` | 改变问题、gap、机制、验证路径之一 | 新建 idea 版本或分支 |
| `Fatal` | 近邻工作已做过、核心假设破裂、资源不可达、实验无法验证 | 打回重构或转模式 |

`Major` 及以上才生成新版本，避免版本噪音。新想法和 frozen idea 冲突时，保留旧版本并开分支比较，不直接覆盖。

### 2.4 暂停与完成

Plan 模式应在以下情况下主动暂停：

- 缺关键论文理解，需要用户补读。
- 关键证据无法验证。
- 算力、数据、时间线或标注能力未知，且影响 idea 是否可行。
- 用户需要先补充背景知识。

一次有效周期的完成标准是冻结 `ResearchIdeaPlan`，而不是用户“感觉聊得差不多”。

## 3. Idea 诊断流程

Plan 模式的第一阶段不是分类，而是理解用户的 idea。不要让用户先选择固定方向，例如 AIGC、Agent、Reasoning；这些只能作为 agent 诊断后的临时标签。

### 3.1 五字段诊断

用户自由描述 idea 后，agent 应输出五字段诊断：

| 字段 | 说明 |
| --- | --- |
| `Problem` | 想解决的研究问题是什么 |
| `Gap` | 现有工作为什么没有解决它 |
| `Candidate Mechanism` | 可能的新机制、算法、理论或评测设计 |
| `Evidence Needed` | 需要哪些文献、实验、理论或数据来支撑 |
| `Main Uncertainty` | agent 当前最不确定的点 |

如果用户纠正了 agent 的理解，agent 必须重写五字段诊断并再次确认。

### 3.2 主动提问规范

Agent 不理解时必须暴露不确定性，而不是装懂。每次提问应满足至少一个条件：

- 会改变 idea 的方向、机制或验证路径。
- 能确认关键假设。
- 能在真实 tradeoff 中做选择。
- 能判断是否需要暂停、补读或重构。

提问时应给出推荐答案和理由。例如：

```text
我现在不确定这个 idea 的核心创新是“新的规划机制”还是“新的评测协议”。
推荐先按“规划机制”推进，因为如果没有新机制，只做 academic workflow 集成很容易被视为工程系统。
你更想主张哪一个？
```

### 3.3 资源与约束询问

Idea 定稿前必须询问并记录：

- 算力：GPU 型号/数量、可用时长、云预算、API budget、存储限制。
- 数据：公开数据、可标注数据、私有数据、数据许可和替代公开验证路径。
- 时间线：目标投稿周期、可投入月份、关键里程碑。
- 用户背景：数学、算法、工程、实验、写作强项和薄弱点。

算力不足时不应自动降低顶会野心，而应采用双轨方案：

- 保留顶会级核心 claim。
- 设计低算力严谨验证路径。
- 标注理想扩展实验。

## 4. 找论文与读论文规范

顶会 idea 不能只靠 agent 想出来。Agent 负责扩大视野、初筛和质询；人必须参与关键论文理解、研究品味判断和最终方向选择。

### 4.1 找论文规范

默认优先来源：

- OpenReview
- ACL Anthology
- PMLR
- NeurIPS / ICML / ICLR 官方页面
- arXiv
- Semantic Scholar / OpenAlex
- DBLP / Crossref
- Papers with Code 和官方项目页

论文选择应遵循：

- 先读最强近邻竞争工作，再读经典论文和拓展论文。
- 默认覆盖近 5 年高相关工作，加少量经典奠基论文。
- 一个候选 idea 进入严肃评审前，默认比较 8-12 篇最相近工作。
- 不能只按引用数排序；应综合 venue、recency、方法严谨性、代码可用性、后续影响和 review 讨论。
- 预印本、workshop、已接收、已发表论文必须明确标注状态。

arXiv 信息只能作为线索，不能直接等同正式发表状态：

- `journal-ref` 和 DOI 可作为较强发表线索。
- `comments` 中的 submitted/accepted 信息属于作者声明，需用 OpenReview、DBLP、出版社或 venue 官网交叉验证。
- 状态无法验证的关键论文不能支撑 `Advance`，只能进入 `Provisional`。

### 4.2 人机共读原则

默认用户需要精读或半精读 5-8 篇关键论文。Agent 可泛读更多论文并整理候选，但不能让用户跳过关键论文理解。

共读提供三种模式：

| 模式 | 用途 |
| --- | --- |
| 快速摘要 | 帮用户判断论文是否值得深读 |
| 引导共读 | Agent 带着用户理解关键机制、实验和假设 |
| 答辩质询 | 检查用户是否真正理解论文贡献和缺口 |

模式可混合使用。对于最相近的 2-3 篇论文，应优先使用引导共读和答辩质询。

### 4.3 贡献链条阅读法

读论文时不要只按章节推进，而要按贡献链条推进：

```text
Problem -> Assumption -> Mechanism -> Evidence -> Limitation
```

每篇关键论文至少要达成四点共识：

- 它解决的核心问题是什么。
- 它的核心机制是什么，删掉哪一步会失效。
- 它的证据是否真的支撑主 claim。
- 它没有解决的 gap、隐藏假设或失败场景是什么。

如果用户读不懂关键部分，agent 应先解释背景和机制，再让用户用自己的话复述，并继续追问其假设、证据和缺口。

### 4.4 Paper Mini-review

每篇关键论文读完后，必须产出 mini-review：

```markdown
### Paper Mini-review: [Title]

- Status: [preprint / accepted / published / unknown]
- Summary:
- Strengths:
- Weaknesses:
- Questions:
- Confidence: [high / medium / low] because ...
- Innovation Hooks:
  1. ...
  2. ...
- Novelty Risk for Our Idea:
```

### 4.5 Innovation Hook

`Innovation Hook` 是从论文中提取的潜在创新入口，不是完整 idea。每个 hook 至少包含五要素：

```markdown
### Innovation Hook

- Trigger Paper:
- Unsolved Problem:
- Candidate Mechanism:
- Why Non-trivial:
- Validation Path:
- Novelty Risk:
- Human Feedback:
```

多个 hooks 生成后，先筛掉重复、纯工程、不可验证和资源不匹配的 hook，再把相关 hook 聚合成 3 个候选 idea。

### 4.6 跨论文综合

多篇论文之间不只做主题聚类，还要做冲突/空白矩阵：

| Paper | Assumption | Mechanism | Evidence | Failure Mode | Gap |
| --- | --- | --- | --- | --- | --- |
| Paper A | | | | | |
| Paper B | | | | | |
| Paper C | | | | | |

候选 idea 应优先来自：

- 多篇论文共享但未解决的 failure mode。
- 强论文之间互相冲突的假设。
- 大 claim 和弱 evidence 之间的差距。
- 高性能方法对大算力、大数据或特殊 setting 的依赖。
- 已有机制有效但原因不清的 unexplained success。

## 5. Review 规范

Review 是 Plan 模式的守门机制。它不只是评价最终 idea，也贯穿读论文和候选筛选。

### 5.1 三层 review

| 层级 | 对象 | 目的 |
| --- | --- | --- |
| Paper mini-review | 单篇关键论文 | 判断论文真实贡献、缺口和可借鉴 hook |
| Candidate idea review | 候选 idea | 判断是否达到顶会候选标准 |
| AC-style meta-review | frozen `ResearchIdeaPlan` 前 | 汇总证据、分歧、风险和最终决策 |

### 5.2 Candidate Idea Review

候选 idea 使用顶会四维加资源适配评分：

| 维度 | 问题 |
| --- | --- |
| `Originality` | 是否有真实 novelty，而非工程组合或场景替换 |
| `Significance` | 问题是否重要，结果是否会影响研究社区 |
| `Soundness` | 机制、假设、实验和逻辑是否站得住 |
| `Clarity` | 主 claim 是否清楚、可证伪、可表达 |
| `Feasibility-Resource Fit` | 算力、数据、时间线和 baseline 是否可行 |

评分建议：

```markdown
### Candidate Idea Review

- Decision: [Reject / Revise / Advance / Provisional]
- Confidence: [high / medium / low]
- Originality: [0-6]
- Significance: [0-6]
- Soundness: [0-6]
- Clarity: [0-6]
- Feasibility-Resource Fit: [0-6]
- Main Strengths:
- Major Weaknesses:
- Most Likely Rejection Reasons:
- Required Revisions:
- Evidence Needed:
```

低置信度 review 不能强判为 `Advance` 或永久 `Reject`，只能标为 `Provisional`，并要求补读论文或补证据。

### 5.3 决策标签

| 标签 | 含义 |
| --- | --- |
| `Reject` | 明确重复、纯工程拼装、不可验证或不符合顶会目标 |
| `Revise` | 有潜力但需要重构问题、机制、证据或资源路径 |
| `Advance` | 通过硬门槛，可冻结为 `ResearchIdeaPlan` |
| `Provisional` | 证据不足或置信度低，暂不能做最终判断 |

一个 idea 进入 `Advance` 前必须满足：

- 重要问题。
- 真实 novelty。
- 核心机制或强贡献。
- 可验证路径。
- 可复现性。
- 伦理和安全检查。
- 算力、数据、时间线可行。

### 5.4 AC-style Meta-review

冻结前由 agent 做 AC 风格综合：

```markdown
### AC-style Meta-review

- Candidate:
- Decision:
- Confidence:
- Evidence Summary:
- Closest Related Work:
- Main Disagreements:
- Resolution of Disagreements:
- Remaining Risks:
- Why This Is Not Engineering Stitching:
- Conditions for Freeze:
```

Meta-review 不应只给结论，必须说明证据链和分歧处理。

## 6. 导师-学生辩论机制

导师-学生辩论不是表演式争论，而是关键分歧处理机制。当用户和 agent 对论文、hook、novelty 或可行性判断不一致时触发。

### 6.1 触发条件

- 用户认为某 idea 有创新，agent 判断接近已有工作。
- 用户认为某论文没有解决问题，agent 判断它已经覆盖了核心 gap。
- 用户认为实验可行，agent 判断算力、数据或 baseline 不足。
- 用户希望继续推进 `Reject` idea。

### 6.2 辩论目标

辩论目标是把分歧转成 evidence question：

```text
不是“谁说得对”，而是“什么论文、实验或逻辑能裁决这个分歧？”
```

### 6.3 Disagreement Log

每次关键辩论结束后保留：

```markdown
### Disagreement Log

- Topic:
- User Position:
- Agent Position:
- Evidence For User Position:
- Evidence For Agent Position:
- Current Resolution:
- Verification Task:
- Impact on Idea Version: [None / Minor / Major / Fatal]
```

如果分歧无法解决，不能强行 `Advance`；应标注 `Provisional` 或暂停等待证据。

## 7. 顶会标准与创新门槛

默认对齐 AI/ML 顶会标准，例如 NeurIPS、ICML、ICLR，以及相关方向的 ACL/EMNLP/CVPR 等。具体 venue 不作为固定入口，而是由用户 idea、近邻文献和 agent 诊断动态判断。

### 7.1 默认创新偏好

优先算法机制创新，例如：

- 新的 reasoning、planning、search、verification 或 tool-use 决策机制。
- 新的训练目标、优化过程、RL/RLAIF 或 curriculum。
- 新的 memory、retrieval、state abstraction 或 credit assignment。
- 新的问题形式化、理论解释或机制分析。

允许严格例外：

- 理论贡献极强。
- Benchmark、数据集或评测协议解决了社区关键盲点。
- 负结果能推翻广泛假设，并提供机制解释和强证据。

### 7.2 工程化缝合检测

以下情况应默认 `Reject` 或建议切换工程/产品模式：

- `LLM + RAG + multi-agent workflow` 但没有新算法机制。
- 只是把已有方法换到新场景。
- 只做系统集成、界面、pipeline 或 prompt 编排。
- 只声称“更自动化”但没有可证伪主 claim。
- 实验只展示 demo，没有强 baseline、ablation 或失败分析。

应用场景可以作为验证载体，但不能替代核心贡献。

### 7.3 可证伪主 claim

每个 `Advance` idea 必须有一个主 claim 和最多两个辅助 claim：

```markdown
Main Claim:
Auxiliary Claim 1:
Auxiliary Claim 2:

What would falsify the main claim:
What result would make this idea not worth pursuing:
```

如果无法说清什么结果会推翻它，说明 idea 还不适合进入 `Advance`。

## 8. 人机分工

| 角色 | 责任 |
| --- | --- |
| Agent | 找论文、初筛、结构化、带读、质疑、review、记录证据 |
| 用户 | 读关键论文、表达直觉、判断兴趣、提供资源约束、做最终方向选择 |
| 共同 | 辩论分歧、定义 claim、判断 novelty、决定是否冻结 |

Agent 不能替用户完成研究品味判断。用户也不能只凭直觉覆盖顶会门槛。分歧必须进入证据辩论。

## 9. 记忆、版本与审计

Plan 模式应维护项目级记忆，不跨项目默认复用。

### 9.1 需要记录

- 当前 idea 版本。
- 用户确认的假设。
- Agent 推断的假设。
- 待验证事实。
- 近邻论文和发表状态。
- Paper mini-reviews。
- Innovation Hooks。
- Candidate idea reviews。
- Disagreement Logs。
- 冻结前 AC-style meta-review。

### 9.2 假设管理

```markdown
### Assumptions

- User-confirmed:
- Agent-inferred:
- To verify:
```

未知事实不能硬猜。应转成 `blocking` 或 `non-blocking` verification task。

### 9.3 保密与外部检索

默认把用户未发表 idea 视为项目内保密信息。若为了 novelty search 需要完整外部查询，应在系统设计中明确该取舍：完整查询更准，但可能暴露部分 idea。审计记录可完整保存，但应限制在项目上下文内。

## 10. 模板

### 10.1 Intake 问题模板

```markdown
## Idea Intake

1. 你现在的粗 idea 或观察是什么？
2. 你认为它解决了什么研究问题？
3. 你觉得现有方法哪里不够？
4. 你倾向的核心贡献是什么：算法机制、理论、benchmark、数据、分析，还是你还不确定？
5. 你的算力、数据、时间线和标注能力是什么？
6. 你最近读过哪些最相关论文？
7. 你最担心这个 idea 被 reviewer 怎么拒？
```

### 10.2 五字段诊断模板

```markdown
## Five-field Diagnosis

- Problem:
- Gap:
- Candidate Mechanism:
- Evidence Needed:
- Main Uncertainty:
- Recommended Next Question:
```

### 10.3 Closest Work Table

```markdown
| Paper | Status | Mechanism | Claim | Evidence | Gap for Us | Novelty Risk |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |
```

### 10.4 ResearchIdeaPlan 模板

```markdown
# ResearchIdeaPlan: [Title]

## Version

- Version:
- Status: [Draft / Provisional / Frozen]
- Decision: [Reject / Revise / Advance]
- Confidence:

## Core Idea

- Main Claim:
- Problem:
- Gap:
- Candidate Mechanism:
- Why Non-trivial:
- Why This Is Not Engineering Stitching:

## Evidence

- Closest Related Work:
- Key Paper Mini-reviews:
- Innovation Hooks Used:
- Disagreement Logs:

## Method Direction

- Algorithmic / Theoretical / Benchmark / Data / Analysis Contribution:
- Mechanism Sketch:
- Expected Failure Mode:
- Falsification Condition:

## Feasibility

- Compute:
- Data:
- Annotation / Human Evaluation:
- Timeline:
- Low-compute Validation:
- Ideal Extended Validation:

## Review

- Originality:
- Significance:
- Soundness:
- Clarity:
- Feasibility-Resource Fit:
- Most Likely Rejection Reasons:
- Required Revisions:

## Ethics and Reproducibility

- Data License / Privacy:
- Safety / Misuse Risk:
- Reproducibility Path:
- Public Benchmark Alternative:

## Freeze Decision

- AC-style Decision:
- Conditions Met:
- Remaining Risks:
- Next Mode:
```

## 11. 示例

### 11.1 示例 A：Academic Agent 粗 idea 被重构

用户粗 idea：

> 做一个 academic agent，能自动读论文、总结相关工作、提出研究 idea。

Agent 轻量诊断：

- `Problem`: 研究者在大量论文中难以发现可发表的创新点。
- `Gap`: 现有 academic assistant 多偏检索、总结、写作，缺少 human-agent 共读和 novelty 审查。
- `Candidate Mechanism`: 不应主张“全自动生成 idea”，而应设计一种 evidence-grounded idea refinement mechanism。
- `Evidence Needed`: human-LLM scientific ideation、paper reading systems、review simulation、agent planning 相关论文。
- `Main Uncertainty`: 核心贡献是算法机制、交互协议，还是评测 benchmark。

Agent 追问：

> 如果只是把 search、RAG、summarization、multi-agent workflow 接起来，这会被视为工程系统。你是否愿意把核心贡献转向“基于共读证据的 idea refinement / novelty risk estimation 机制”？

可能重构后的候选：

> 一种 human-agent co-reading based research idea refinement framework。它把论文阅读转化为可审计的 `Innovation Hooks` 和 `Disagreement Logs`，并通过 reviewer-style novelty risk estimation 帮助研究者从近邻文献中形成可证伪的 AI research idea。

Review 判断：

- `Originality`: 需要强检索确认，初步有潜力。
- `Significance`: 如果能证明比普通 LLM brainstorming 更能产生高 novelty ideas，意义较强。
- `Soundness`: 需要明确 hook extraction、disagreement resolution 和 novelty risk scoring 机制。
- `Feasibility-Resource Fit`: 可用低算力做用户研究和离线评测。
- `Decision`: `Revise`，补近邻文献和机制定义后可能 `Advance`。

### 11.2 示例 B：工程拼装 idea 被 Reject

用户粗 idea：

> 做一个 LLM + RAG + multi-agent workflow，用来帮科研人员自动写 related work、找 gap、生成实验计划。

Agent 诊断：

- `Problem`: 科研 workflow 自动化。
- `Gap`: 描述的是产品痛点，不是清楚的研究 gap。
- `Candidate Mechanism`: 目前只有 RAG、multi-agent 和 workflow 编排，没有新算法机制。
- `Evidence Needed`: 需要证明现有 academic assistant 没有解决某个具体能力，而不是泛称“更自动化”。
- `Main Uncertainty`: 核心学术 claim 不明确。

Review：

- `Originality`: 低。已有大量 RAG/agent workflow 系统相近。
- `Significance`: 应用有价值，但学术贡献不清。
- `Soundness`: 缺少可证伪 claim。
- `Clarity`: “自动写 related work、找 gap”范围过宽。
- `Feasibility-Resource Fit`: 可做 demo，但 demo 不等于顶会贡献。
- `Decision`: `Reject` for Idea Plan Mode。

重构路线：

- 转向工程/产品模式：做一个可用 academic assistant。
- 或重构为研究 idea：定义一个具体机制，例如 novelty risk estimation、human-agent disagreement resolution、或 literature-grounded hypothesis falsification，并用强 baseline 评测。

## 12. 参考标准

- ICLR Reviewer Guide: https://iclr.cc/Conferences/2025/ReviewerGuide
- NeurIPS Reviewer Guidelines: https://neurips.cc/Conferences/2025/ReviewerGuidelines
- OpenReview: https://openreview.net
- Keshav, "How to Read a Paper": https://read.seas.harvard.edu/cs161/2022/pdf/keshav16how.pdf

这些参考只提供评审和阅读规范的外部锚点。具体到本模式，核心原则是：读论文产生证据和 hooks，review 判断 hooks/idea 是否具有顶会价值，辩论处理人机分歧，最后由 frozen `ResearchIdeaPlan` 承接到 `Experiment Design Mode` 和后续执行模式。
