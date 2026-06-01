# 学术 Agent Experiment Design Mode 设计规范

## 1. 目标与角色定位

`Experiment Design Mode` 是学术 agent 中用于设计顶会级实验蓝图的研究对话模式。它是 `Idea Plan Mode` 的独立后继模式：

```text
ResearchIdeaPlan frozen
-> Experiment Blueprint frozen
-> Execution Package frozen
-> Result Analysis Report frozen
-> Manuscript Package frozen
-> Submission / Rebuttal / Camera-ready
```

它的核心角色是：

> 实验架构师 + 顶会 Reviewer

它不负责直接跑实验、写代码或撰写论文实验章节，而是负责设计能证明、削弱或推翻主 claim 的证据结构。它要像实验架构师一样组织实验，也要像 reviewer 一样质疑 baseline、metric、ablation、统计可靠性和可复现性。

### 1.1 核心职责

- 把 frozen `ResearchIdeaPlan` 中的主 claim 转成可验证的 `Claim-Evidence Map`。
- 设计主实验、强 baseline、ablation、机制诊断、鲁棒性/泛化、人评和复现实验。
- 明确每个实验支持哪个 claim，以及什么结果会 `support / weaken / falsify` 该 claim。
- 检查实验是否符合用户算力、数据、时间线和目标 venue 标准。
- 在实验无法支撑 claim 时直接指出问题，并退回 `Idea Plan Mode` 或要求重构。
- 产出 frozen `Experiment Blueprint`，供后续 `Execution Plan Mode` 拆分任务、代码、资源和时间线；执行模式完成后冻结 `Execution Package`，再进入 `Result Analysis Mode` 审计结果，然后才能交给 `Writing / Revision Mode`。

### 1.2 非目标

- 不直接写实验脚本、训练代码或自动化 pipeline。
- 不直接生成论文实验章节。
- 不把“跑更多 benchmark”当成实验严谨性的替代品。
- 不允许弱 baseline、错 metric 或缺 ablation 的蓝图进入执行。

### 1.3 语气与权力边界

- Agent 应直接指出实验无法支撑 claim 的位置。
- 每个批评都要给修复路径，例如补 baseline、改 metric、重写 claim、增加 ablation，或退回 idea 重构。
- 用户可以选择继续探索低置信实验路线，但 agent 不能把未达标蓝图标记为 `Freeze`。

## 2. 启动条件与模式边界

`Experiment Design Mode` 只能在 frozen `ResearchIdeaPlan` 之后启动，避免为不成熟 idea 设计一堆看似完整但无法支撑顶会贡献的实验。

### 2.1 启动所需输入

最低输入包括：

- `Main Claim`: 论文最核心、可证伪的主张。
- `Mechanism Sketch`: 方法机制草图，说明为什么应该有效。
- `Closest Related Work`: 最相近工作及 novelty risk。
- `Compute Profile`: GPU/API/预算/时间/存储条件。
- `Data Profile`: 数据来源、许可、切分、标注能力和公开替代。
- `Target Standard`: 目标 venue 或评审标准，例如 AI/ML 顶会。

如果这些输入缺失，agent 应先回到 `Idea Plan Mode` 或要求补充，不应直接设计实验。

### 2.2 反向门禁

实验设计过程中出现以下情况，应退回 `Idea Plan Mode`：

- 主 claim 无法被实验支持或推翻。
- 最强近邻 baseline 不可达，且没有合理替代证据。
- 数据条件无法支撑主 claim。
- 算力和时间线无法完成 must-have 实验。
- metric 无法测量 claim 中真正关心的能力。
- claim-evidence 断裂，只能通过叙事而非证据支撑。

退回时必须说明影响等级：

| 等级 | 含义 | 处理 |
| --- | --- | --- |
| `Major` | claim、实验或资源路径需要重构 | 回到 Idea Plan 修改版本 |
| `Fatal` | idea 当前不可验证或已不成立 | 打回重构或转模式 |

### 2.3 完成标准

一次有效实验设计周期的完成标准是冻结 `Experiment Blueprint`。冻结后才能进入 `Execution Plan Mode`；执行完成后必须冻结 `Execution Package`，再进入 `Result Analysis Mode` 审计和解释。

## 3. 核心哲学：Claim-Evidence 对齐

实验设计的核心不是追榜、堆表或覆盖最多 benchmark，而是建立清晰的 claim-evidence 结构。

### 3.1 每个 claim 都必须可验证

每个主 claim 必须定义：

```markdown
- Claim:
- Evidence Needed:
- Support Result:
- Weaken Result:
- Falsify Result:
- Required Experiment:
```

其中：

- `Support Result`: 什么结果会支持 claim。
- `Weaken Result`: 什么结果会削弱但不完全推翻 claim。
- `Falsify Result`: 什么结果会说明 claim 不成立。

如果无法定义 `Falsify Result`，说明 claim 不够可证伪，应回到 `Idea Plan Mode`。

### 3.2 主实验的职责

主实验只负责回答论文核心 claim 是否成立，不负责证明所有细节。细节应由 ablation、机制分析、鲁棒性实验和人评补充。

主实验不能只追求最好性能。若 SOTA 性能不是主 claim，就不应让排行榜压倒机制验证。

### 3.3 实验分层

所有实验应分成三层：

| 层级 | 含义 |
| --- | --- |
| `must-have` | 缺失则无法支撑主 claim |
| `should-have` | 显著增强说服力，但资源不足时可延后 |
| `ideal` | 理想资源下的扩展验证，用于申请资源或后续工作 |

低算力情况下应保留 must-have 实验的严谨性，而不是通过降低 baseline 强度来制造优势。

## 4. Experiment Blueprint 结构

冻结产物为 `Experiment Blueprint`：

```markdown
# Experiment Blueprint: [Title]

## Version

- Linked ResearchIdeaPlan:
- Status: [Draft / Provisional / Frozen]
- Decision: [Reject / Revise / Freeze]
- Confidence:

## Core Claim

- Main Claim:
- Auxiliary Claims:
- Mechanism Summary:
- Target Venue Standard:

## Claim-Evidence Map

| Claim | Evidence Needed | Experiment | Support | Weaken | Falsify |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

## Experiment Set

- Main Experiment:
- Baseline Comparison:
- Ablation:
- Mechanism / Diagnostic Analysis:
- Robustness / Generalization:
- Human Evaluation:
- Negative / Failure Case Analysis:

## Resources

- Compute:
- API Budget:
- Data:
- Annotation / Human Evaluation:
- Timeline:
- Must-have Experiments:
- Should-have Experiments:
- Ideal Experiments:

## Reproducibility

- Code / Config Plan:
- Seeds:
- Environment:
- Data Processing:
- Logging:
- Model / API Versions:
- Result Table Templates:

## Review

- Reviewer Concerns:
- AC-style Decision:
- Required Revisions:
- Freeze Conditions:
```

## 5. 实验类型规范

默认实验包包含五类核心实验，外加人评和失败分析。

### 5.1 主实验

主实验验证主 claim。它需要明确：

- 数据集或任务。
- 主要 baseline。
- 主指标。
- 统计可靠性设计。
- 支持、削弱和推翻 claim 的结果模式。

### 5.2 强 baseline 对比

Baseline 选择必须包含：

- 最强近邻方法：最可能被 reviewer 用来质疑 novelty 的方法。
- 经典代表方法：社区熟悉、可解释的参照。
- 简单 sanity baseline：验证新方法不是只赢了过弱对手。

不可复现 SOTA 不能直接跳过。应记录：

```markdown
- Missing Baseline:
- Why Not Reproducible:
- Evidence Substitute:
- Scaled-down Reproduction:
- Threat to Validity:
```

如果优势只在弱 baseline 上成立，不能支撑主 claim。Agent 应要求降级 claim、重构机制或退回 `Idea Plan Mode`。

### 5.3 Ablation

Ablation 的目标是证明核心机制必要性，不是填表。

必须进入 ablation 的内容包括：

- 主 claim 依赖的核心机制。
- 关键训练目标、推理规则、规划规则或检索策略。
- 记忆、检索、工具调用、验证器、reranker 等关键模块。
- 关键超参或决策阈值。

Ablation 表模板：

```markdown
| Component / Design | Why It Matters | Remove / Replace With | Expected Change | Actual Result | Interpretation |
| --- | --- | --- | --- | --- | --- |
| | | | | | |
```

### 5.4 机制与诊断分析

算法机制类 idea 至少要包含机制解释。若不能做理论证明，也应设计：

- Toy setting 或 controlled setting。
- Error analysis。
- Behavior tracing。
- Causal or counterfactual diagnostics。
- Case studies that expose the mechanism。

机制分析要回答：

```text
为什么这个方法有效？
什么时候会失败？
失败是否符合机制解释？
```

### 5.5 鲁棒性与泛化

鲁棒性/泛化维度由 claim 决定，而不是固定套模板。可选维度包括：

- 跨数据集。
- 跨模型。
- 跨 domain。
- 分布外样本。
- 长尾和难例。
- prompt 或输入扰动。
- 工具失败、检索失败、噪声文档或不完整上下文。

如果 claim 涉及 generalization，但蓝图没有泛化实验，应标记为 `Revise`。

### 5.6 负结果与失败案例

必须主动设计负结果和失败案例分析：

- 哪些 setting 下预期失败。
- 失败是否符合机制解释。
- 哪些失败会推翻主 claim。
- 哪些失败只说明边界条件。

不允许只设计成功案例展示。

## 6. Metric 与统计规范

Metric 必须由 claim 驱动。不要为了表格好看而堆指标。

### 6.1 指标分类

| 类型 | 用途 |
| --- | --- |
| 主指标 | 直接衡量主 claim |
| 辅助指标 | 支撑辅助 claim 或解释 tradeoff |
| 诊断指标 | 解释机制或错误来源 |
| 成本指标 | 衡量训练/推理/API/延迟/显存成本 |

Metric 表模板：

```markdown
| Metric | Type | Linked Claim | Why Appropriate | Failure Mode It Can Miss |
| --- | --- | --- | --- | --- |
| | | | | |
```

### 6.2 统计可靠性

默认要求：

- 多随机种子。
- Error bars 或 confidence intervals。
- 显著性检验或效应量说明。
- 样本量理由。
- 若无法多 seed，必须记录原因和风险。

### 6.3 成本与效率

LLM/agent 实验默认记录：

- 训练成本。
- 推理成本。
- API/token cost。
- 延迟。
- 显存。
- 存储和索引成本。
- 人评标注成本。

如果方法性能提升很小但成本显著上升，必须在蓝图中标注 tradeoff 风险。

## 7. 数据与 Human Evaluation 规范

### 7.1 数据规范

数据部分必须记录：

```markdown
- Dataset:
- Source:
- License:
- Preprocessing:
- Train / Dev / Test Split:
- Leakage Risk:
- Retrieval Overlap Risk:
- Public Alternative:
- Privacy / Ethics Notes:
```

LLM/agent 实验默认检查：

- 训练污染。
- prompt 泄漏。
- test set overfitting。
- retrieval overlap。
- benchmark contamination。
- 私有数据无法复现的问题。

私有数据可以增强实验，但必须提供公开 benchmark 或可复现实验替代。

### 7.2 Human Evaluation

涉及生成质量、agent 行为、开放式任务、科研辅助质量或主观判断时，默认要求协议化 human evaluation。

Human eval 设计必须包含：

```markdown
- Evaluation Dimensions:
- Annotation Guideline:
- Rater Type: [expert / trained annotator / crowd worker / target user]
- Blind / Randomized Protocol:
- Sample Size:
- Inter-annotator Agreement:
- Ethics / Consent:
- Compensation:
- Disagreement Resolution:
```

简单“让几个人打分”不符合顶会级实验蓝图。

## 8. 复现与日志规范

### 8.1 最小复现包

Experiment Blueprint 应要求最小复现包：

- 代码计划。
- 配置文件。
- 随机种子。
- 环境和依赖。
- 数据处理流程。
- 日志指标。
- 模型/API 版本。
- 结果表模板。

### 8.2 API 模型复现风险

如果实验依赖商业 API 模型，必须记录：

- 模型名称和版本。
- 调用日期。
- 参数设置。
- 成本。
- 输出缓存策略。
- 开源替代模型。
- 模型漂移风险。

API 模型可以作为资源，但不能把不可复现风险藏起来。

### 8.3 实验日志

执行模式必须继承并落实实验日志要求：

- 成功实验。
- 失败实验。
- 异常。
- 调参路径。
- 被放弃实验及原因。
- 与原始蓝图不一致的偏离。

只记录成功结果会导致 survivorship bias，不符合本模式标准。

## 9. Review 规范

Experiment Blueprint 冻结前必须经过 `Reviewer + AC` 审查。

### 9.1 Reviewer 审查

Reviewer 优先寻找：

- Claim 没有实验支撑。
- Baseline 太弱或缺最强近邻。
- Metric 测不到 claim。
- Ablation 缺核心机制。
- 失败标准不清。
- 数据泄漏或 benchmark contamination。
- 统计可靠性不足。
- 资源计划不现实。

Reviewer 输出：

```markdown
### Experiment Reviewer Report

- Decision: [Reject / Revise / Freeze]
- Confidence:
- Claim-Evidence Gaps:
- Baseline Risks:
- Metric Risks:
- Ablation Missing:
- Data / Leakage Risks:
- Reproducibility Risks:
- Required Fixes:
```

### 9.2 AC-style 审查

AC 负责综合 reviewer concerns，并判断是否冻结：

```markdown
### Experiment AC Meta-review

- Final Decision: [Reject / Revise / Freeze]
- Confidence:
- Evidence Sufficiency:
- Major Remaining Risks:
- Must-fix Before Freeze:
- Can Move to Execution Plan: [yes / no]
```

### 9.3 决策标签

| 标签 | 含义 |
| --- | --- |
| `Reject` | 当前实验蓝图无法支撑 claim，或 idea 不可验证 |
| `Revise` | 蓝图有潜力，但需补 baseline、metric、ablation、数据或复现设计 |
| `Freeze` | 蓝图足以交给执行计划模式 |

`Freeze` 后才能进入 `Execution Plan Mode`。

## 10. 结果回流

实验执行完成后，`Execution Plan Mode` 必须先冻结 `Execution Package`。随后结果进入 `Result Analysis Mode`，回流到实验蓝图和 idea 判断中，而不是直接进入论文写作。

### 10.1 结果解释

每个实验结果都要归类：

| 结果类型 | 含义 | 后续处理 |
| --- | --- | --- |
| `Support` | 支持 claim | 可进入论文证据组织 |
| `Weaken` | 削弱 claim 或暴露边界 | 修改 claim、补实验或增加 limitation |
| `Falsify` | 推翻 claim | 回到 Experiment Design 或 Idea Plan |
| `Inconclusive` | 无法判断 | 补数据、补统计或重设实验 |

### 10.2 偏离记录

如果执行阶段偏离蓝图，必须记录：

- 偏离内容。
- 偏离原因。
- 对 claim 的影响。
- 是否需要重新 review。

## 11. 示例：Academic Agent Idea 的实验蓝图

### 11.1 Frozen Idea 摘要

主 claim：

> Human-agent co-reading with structured `Innovation Hooks` and `Disagreement Logs` can produce research ideas with higher novelty-risk awareness and stronger claim-evidence alignment than ordinary LLM brainstorming.

机制草图：

- Agent 带用户读近邻论文。
- 每篇论文产出 mini-review 和 `Innovation Hooks`。
- 人机分歧进入 `Disagreement Log`。
- 候选 idea 通过 reviewer-style novelty risk estimation 过滤。

### 11.2 Claim-Evidence Map

| Claim | Evidence Needed | Experiment | Support | Weaken | Falsify |
| --- | --- | --- | --- | --- | --- |
| 共读机制提升 novelty-risk awareness | 与普通 LLM brainstorming 对比 | 用户研究或离线模拟 | 用户能更准确识别相近工作和重复风险 | 只在部分任务提升 | 与 baseline 无差异或更差 |
| Innovation Hooks 改善 idea 质量 | hook 到 idea 的转化质量 | Hook ablation | 去掉 hooks 后 idea 更泛或更工程化 | 只改善 clarity 不改善 novelty | 无差异 |
| Disagreement Logs 改善 claim-evidence 对齐 | 分歧是否转成证据任务 | Disagreement ablation | 去掉 logs 后 unsupported claims 增多 | 只在专家用户有效 | 无差异或增加负担 |

### 11.3 Must-have 实验

- 主实验：比较 `co-reading mode` 与 `ordinary LLM brainstorming` 在同一组 AI research topics 上生成 idea 的质量。
- Baseline：
  - 普通 LLM brainstorming。
  - RAG literature summary + idea generation。
  - Multi-agent reviewer/planner workflow。
  - Human-only reading notes。
- 主指标：
  - Novelty-risk awareness。
  - Claim-evidence alignment。
  - Reviewer-rated research promise。
- 人评：
  - 由 AI/ML 方向博士生或研究者盲评。
  - 随机化 idea 顺序。
  - 评估 novelty、significance、soundness、clarity。
- Ablation：
  - 去掉 `Innovation Hooks`。
  - 去掉 `Disagreement Logs`。
  - 去掉 reviewer-style critique。

### 11.4 Should-have 实验

- 跨领域 topics：LLM agent、AIGC、reasoning、efficient ML。
- 不同用户水平：新手研究者 vs 有论文经验研究者。
- 成本分析：时间成本、API cost、用户阅读负担。
- 失败案例：系统在哪些 topic 上产生过度保守或过度发散的 idea。

### 11.5 Ideal 实验

- 长周期真实研究跟踪：观察 idea 是否进入 proposal、实验或投稿。
- 与真实导师组会流程比较。
- 多机构、多用户复现。

### 11.6 Review 判断

- `Originality`: 取决于近邻 human-LLM ideation 和 academic assistant 工作是否已覆盖该机制。
- `Significance`: 若能提升研究者 idea 质量和 novelty 判断，意义较强。
- `Soundness`: 需要严格人评协议，避免主观偏差。
- `Feasibility`: 可低算力完成，但需要高质量人工评估。
- `Decision`: `Revise` until nearest-work comparison and human eval protocol are strong enough; then `Freeze`。

## 12. 参考标准

- NeurIPS Paper Checklist: https://nips.cc/public/guides/PaperChecklist
- ICLR Author Guide: https://iclr.cc/Conferences/2024/AuthorGuide
- ICLR Reviewer Guide: https://iclr.cc/Conferences/2025/ReviewerGuide
- OpenReview: https://openreview.net

这些标准提供实验严谨性、复现性和 review 视角的外部锚点。本模式的核心原则是：实验蓝图必须让每个 claim 都有明确证据、失败标准、资源计划和复现路径。
