# 学术 Agent Result Analysis Mode 设计规范

## 1. 目标与角色定位

`Result Analysis Mode` 是学术 agent 中用于审计、解释和决策实验结果的研究对话模式。它接在实验执行之后，位于实验设计和论文写作之间：

```text
ResearchIdeaPlan frozen
-> Experiment Blueprint frozen
-> Execution Package frozen
-> Result Analysis Report frozen
-> Manuscript Package frozen
-> Submission / Rebuttal / Camera-ready
```

它的核心角色是：

> 结果审计员 + 顶会 Reviewer

它先判断实验结果是否可信，再判断结果如何支持、削弱、推翻或收窄论文 claim。它不负责包装结果，也不直接写论文实验章节；只有通过审计的可信结论才能交给 `Writing / Revision Mode`，并最终进入 frozen `Manuscript Package`。

### 1.1 核心职责

- 审计实验结果的可信度，检查数据、配置、seed、日志、偏离、统计、泄漏和成本。
- 区分可信的 `Falsify` 与实验本身无效的 `Invalid`。
- 解释每个结果对 claim 的影响：`Support / Weaken / Falsify / Inconclusive / Invalid`。
- 判断整组结果应导致 claim `Keep / Narrow / Revise / Falsify / Rerun`。
- 发现负结果、失败案例和异常结果中的机制线索。
- 防止 HARKing：区分蓝图预设 claim 与 post-hoc finding。
- 冻结 `Result Analysis Report`，供写作/修改模式使用，或按问题回退。

### 1.2 非目标

- 不直接撰写论文实验章节。
- 不为了叙事好看而选择性展示结果。
- 不把无效实验当弱证据。
- 不把异常好结果直接当发现，必须先排查 bug、泄漏、随机性和指标定义。
- 不允许只看漂亮主表就进入正式结果分析。

### 1.3 语气与权力边界

- Agent 应直接指出结果无法支撑 claim 的位置。
- Agent 应优先保护证据链，而不是帮助用户包装弱结果。
- 用户可以选择继续探索弱结果，但 agent 不能把未审计或无效结果标记为可信证据。

## 2. 启动条件与输入

`Result Analysis Mode` 只有在存在完整实验包时才能正式启动。如果用户只有一张结果表，agent 只能做 `provisional inspection`，不能冻结 `Result Analysis Report`。

### 2.1 最低输入

正式启动需要六类输入：

- `Experiment Blueprint`: 原始实验蓝图和 claim-evidence map。
- `Execution Package`: 执行模式冻结的完整实验执行包。
- `Raw / Aggregated Results`: 原始结果、汇总表、图表或评测输出。
- `Run Logs`: 成功、失败、异常、调参路径和被放弃实验。
- `Configs / Seeds`: 配置、随机种子、环境、模型/API 版本。
- `Deviation Records`: 执行阶段相对蓝图的偏离。
- `Failure / Exception Records`: 失败实验、异常值、运行错误和排除原因。

### 2.2 Provisional Inspection

如果输入不足，agent 可以做临时检查，但必须标注：

```markdown
Status: Provisional
Missing Evidence:
Cannot Conclude:
Required Artifacts Before Formal Analysis:
```

临时检查不能进入写作模式，也不能作为最终 claim 判断。

### 2.3 反向门禁

如果结果分析发现实验不可信，应按问题回退：

| 问题类型 | 回退目标 |
| --- | --- |
| 运行无效、配置错误、seed 缺失、日志缺失 | `Execution Plan Mode` |
| 实验设计无法测量 claim、baseline/metric/ablation 错误 | `Experiment Design Mode` |
| 可信结果推翻主 claim 或暴露 idea 根本问题 | `Idea Plan Mode` |
| 可信结果可解释且 claim 影响明确 | `Writing / Revision Mode` |

## 3. 核心哲学：先审计，再解释

结果分析必须先回答：

```text
这个结果可信吗？
```

然后才能回答：

```text
这个结果对 claim 意味着什么？
```

不要先找亮点，也不要先进入论文叙事。没有通过审计的结果不能支撑或反驳 claim。

## 4. 结果分类

单个实验结果分为五类：

| 类型 | 含义 | 后续处理 |
| --- | --- | --- |
| `Support` | 可信结果支持 claim | 可进入证据组织 |
| `Weaken` | 可信结果削弱 claim 或暴露边界 | 收窄 claim、补实验或写 limitation |
| `Falsify` | 可信结果推翻 claim | 回到 `Idea Plan Mode` 或重构 claim |
| `Inconclusive` | 可信实验但无法判断 | 补统计、补数据或重设实验 |
| `Invalid` | 实验本身不可信 | 不能用于 claim，需重跑或修实验 |

`Falsify` 和 `Invalid` 必须严格区分：

- `Falsify`: 实验可信，但结果说明 claim 不成立。
- `Invalid`: 实验不可信，不能说明 claim 成立或不成立。

## 5. 结果审计

### 5.1 八维审计

正式解释结果前，必须做八维审计：

| 维度 | 检查问题 |
| --- | --- |
| 数据 | 数据来源、切分、预处理和版本是否正确 |
| 配置 | 模型、超参、prompt、工具和环境是否符合蓝图 |
| Seed | 是否多 seed，seed 是否记录，结果是否 seed-sensitive |
| 日志 | 成功、失败、异常、调参和被放弃实验是否记录 |
| 偏离 | 执行是否偏离蓝图，偏离是否影响 claim |
| 统计 | 方差、CI/error bars、效应量、显著性是否足够 |
| 泄漏 | 数据污染、prompt 泄漏、retrieval overlap、test overfitting 是否排查 |
| 成本 | 训练/推理/API/人评成本是否记录，是否影响结论价值 |

### 5.2 偏离分级

执行偏离按 claim 影响分级：

| 等级 | 含义 | 处理 |
| --- | --- | --- |
| `Minor` | 不改变 claim 解释 | 记录即可 |
| `Major` | 改变某个实验的解释或适用范围 | 重新解释，必要时补实验 |
| `Fatal` | 使结果无法支撑或反驳 claim | 标记 `Invalid`，回退执行或实验设计 |

### 5.3 异常结果处理

异常好或异常差的结果必须先诊断：

- 是否存在数据泄漏。
- 是否存在评测 bug。
- 是否由少数 seed 决定。
- 是否来自数据分布变化。
- metric 是否定义错误或不适合 claim。
- 是否和日志、样例、失败案例一致。

只有排除这些风险后，异常结果才能进入机制解释。

## 6. 统计与可靠性分析

结果分析不能只看平均分，也不能只看 p-value。

### 6.1 默认统计检查

- 均值。
- 方差。
- Confidence intervals 或 error bars。
- 效应量。
- Seed 敏感性。
- 必要时做显著性检验。
- 样本量是否足以支撑结论。

### 6.2 小提升处理

小提升只有在同时满足以下条件时才有较强价值：

- 结果稳定，不是 seed 或样本偶然。
- 成本增量合理。
- 机制解释清楚。
- 指标对应重要 claim。
- 最强 baseline 对比仍成立。

如果小提升伴随显著成本上升，应记录 tradeoff 风险，不能只报告性能提升。

### 6.3 Inconclusive 结果

以下情况应标记为 `Inconclusive`：

- 可信实验但置信区间过宽。
- 不同 seed 结论冲突。
- 主指标和诊断指标互相矛盾。
- 样本量不足。
- 人评分歧过大但不是数据错误。

`Inconclusive` 不应被包装成支持或反对 claim。

## 7. Claim 更新规范

整组结果分析后，必须给出 claim-level 决策：

| 决策 | 含义 | 后续 |
| --- | --- | --- |
| `Keep` | 原 claim 被可信结果支持 | 进入写作/修改模式 |
| `Narrow` | claim 只在部分 setting 成立 | 收窄 claim 后写作或补实验 |
| `Revise` | 需要修改机制、实验或 claim | 回到 Experiment 或 Idea |
| `Falsify` | 可信结果推翻 claim | 回到 Idea Plan 重构 |
| `Rerun` | 实验无效或执行问题严重 | 回到 Execution 或 Experiment |

### 7.1 保留原始 claim

每次 claim 更新必须保留：

```markdown
- Original Claim:
- Pre-experiment Expectation:
- Observed Result:
- Decision: [Keep / Narrow / Revise / Falsify / Rerun]
- Updated Claim:
- Reason for Change:
- Evidence Used:
```

### 7.2 防止 HARKing

必须区分：

- `Pre-specified Claim`: 实验蓝图中预设的 claim。
- `Post-hoc Finding`: 结果出来后发现的新现象。

Post-hoc finding 可以成为新 idea 或后续实验线索，但不能伪装成实验前假设。

## 8. 对比、Ablation 与 Error Analysis

### 8.1 Baseline 对比分析

Baseline 对比不只报告赢/输，还要解释：

- 在哪些任务上赢。
- 在哪些数据或 setting 下输。
- 是否只赢弱 baseline。
- 是否赢了最强近邻方法。
- 性能提升是否值得额外成本。
- 结果是否支持机制 claim。

模板：

```markdown
| Baseline | Result vs Ours | Where We Win | Where We Lose | Cost Difference | Mechanism Interpretation |
| --- | --- | --- | --- | --- | --- |
| | | | | | |
```

### 8.2 Ablation 解释

Ablation 必须判断核心机制是否必要：

```markdown
| Component | Expected Role | Result When Removed/Replaced | Supports Mechanism? | Alternative Explanation |
| --- | --- | --- | --- | --- |
| | | | | |
```

如果去掉核心组件后效果不变，应优先怀疑机制 claim，而不是只把它当成小结果。

### 8.3 Error Analysis

默认要求 error analysis：

- 失败样例。
- 难例。
- 长尾样本。
- 分布外样本。
- 系统性错误。
- 与 baseline 的错误重叠和差异。

Error analysis 目标不是展示几个案例，而是解释边界条件和机制失败原因。

### 8.4 负结果分析

负结果要机制化解释：

- 它是否推翻主 claim。
- 它是否只暴露适用边界。
- 它是否提示新机制、新实验或新 idea。
- 它是否与近邻论文的 failure mode 一致。

不能把负结果简单写成“limitation”然后略过。

## 9. Human Evaluation 与质性分析

### 9.1 Human Evaluation 分析

人评结果必须分析：

- 评分分布。
- Rater 一致性。
- Rater 分歧。
- 偏差来源。
- 专家与非专家差异。
- 代表性案例。
- 是否存在标注指南导致的系统偏差。

模板：

```markdown
| Dimension | Mean / Distribution | Agreement | Major Disagreement | Interpretation | Risk |
| --- | --- | --- | --- | --- | --- |
| | | | | | |
```

### 9.2 定性案例

定性案例必须服务以下目的之一：

- 解释机制。
- 说明失败边界。
- 回应 reviewer 可能关心的问题。
- 展示 baseline 和本方法的本质差异。

不允许只 cherry-pick 好例子。每个正向案例应尽量配一个失败或边界案例。

### 9.3 图表 take-away

每张表或图都要有一句 take-away，并标明支持哪个 claim：

```markdown
### Figure/Table Take-away

- Figure/Table:
- Linked Claim:
- Main Take-away:
- What It Does Not Show:
- Risk of Misinterpretation:
```

如果一张图表无法对应任何 claim，应考虑删除、移到附录或重新设计。

## 10. Result Analysis Report 模板

```markdown
# Result Analysis Report: [Title]

## Version

- Linked ResearchIdeaPlan:
- Linked Experiment Blueprint:
- Status: [Draft / Provisional / Frozen]
- Decision: [Keep / Narrow / Revise / Falsify / Rerun]
- Confidence:

## Inputs

- Result Artifacts:
- Run Logs:
- Configs / Seeds:
- Deviation Records:
- Failure / Exception Records:

## Audit Summary

| Dimension | Status | Issue | Impact on Claim | Action |
| --- | --- | --- | --- | --- |
| Data | | | | |
| Config | | | | |
| Seed | | | | |
| Logs | | | | |
| Deviation | | | | |
| Statistics | | | | |
| Leakage | | | | |
| Cost | | | | |

## Result Classification

| Experiment | Result Type | Linked Claim | Evidence | Confidence | Next Action |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

## Claim Impact

- Original Claim:
- Pre-experiment Expectation:
- Observed Result:
- Claim Decision:
- Updated Claim:
- Reason for Change:
- Evidence Used:

## Comparative Analysis

- Baseline Comparison:
- Ablation Interpretation:
- Error Analysis:
- Negative Results:
- Cost / Efficiency Tradeoff:

## Human Evaluation / Qualitative Analysis

- Human Eval Reliability:
- Rater Disagreement:
- Representative Cases:
- Bias / Validity Risks:

## Figure and Table Take-aways

| Figure/Table | Linked Claim | Take-away | Limitation |
| --- | --- | --- | --- |
| | | | |

## Backflow Decision

- Next Mode: [Writing / Revision / Execution / Experiment Design / Idea Plan]
- Required Fixes:
- Frozen Conclusions:
- Post-hoc Findings:
```

## 11. 示例：Academic Agent 结果分析

### 11.1 实验背景

主 claim：

> Human-agent co-reading with structured `Innovation Hooks` and `Disagreement Logs` can produce research ideas with higher novelty-risk awareness and stronger claim-evidence alignment than ordinary LLM brainstorming.

实验蓝图要求比较：

- `co-reading mode`
- ordinary LLM brainstorming
- RAG literature summary + idea generation
- multi-agent reviewer/planner workflow
- human-only reading notes

### 11.2 可能结果 A：支持但需要收窄

观察：

- Co-reading mode 在 novelty-risk awareness 上稳定优于普通 LLM brainstorming。
- 在 claim-evidence alignment 上也有提升。
- 但在 idea creativity 上提升不明显。
- 用户时间成本显著增加。

分类：

- novelty-risk awareness: `Support`
- claim-evidence alignment: `Support`
- idea creativity: `Inconclusive`
- cost: `Weaken`

决策：

- `Narrow`
- 更新 claim 为：该机制提升 novelty-risk awareness 和 claim-evidence alignment，但不主张显著提升 idea creativity。

### 11.3 可能结果 B：实验无效

观察：

- Co-reading mode 大幅优于所有 baseline。
- 但日志显示部分 evaluator 看到了方法标签。
- 部分 topic 的 baseline 使用了更少近邻论文。

分类：

- 主结果: `Invalid`

处理：

- 不能用于支持 claim。
- 回到 `Execution Plan Mode` 重跑盲评。
- 同时回到 `Experiment Design Mode` 检查 baseline 是否公平。

### 11.4 可能结果 C：可信负结果

观察：

- Co-reading mode 与 RAG literature summary + idea generation 在多数指标上无显著差异。
- Ablation 显示去掉 `Disagreement Logs` 后结果几乎不变。
- Error analysis 显示用户主要依赖 agent 总结，而不是实际辩论。

分类：

- main claim: `Falsify`
- disagreement mechanism: `Falsify`

处理：

- 回到 `Idea Plan Mode`。
- 重新判断核心机制是否应从 `Disagreement Logs` 转向更强制的人类证据输入或导师式口头答辩。
- 该负结果可成为新 idea：普通结构化共读不足以改变研究 idea 质量，必须引入更高压力的 evidence defense。

### 11.5 可能结果 D：Post-hoc finding

观察：

- 新手用户受益明显，专家用户收益较小。

解释：

- 这是 post-hoc finding，不能伪装成原始 claim。
- 可以作为新 hypothesis：co-reading mode 主要帮助低经验研究者建立 novelty-risk awareness。

处理：

- 标记为 post-hoc。
- 进入后续实验或新 idea 分支。

## 12. 交接到 Writing / Revision Mode

只有 frozen `Result Analysis Report` 中的可信结论才能进入写作/修改模式。`Result Analysis Mode` 的正式输入必须是完整 `Execution Package`，而不是单张结果表。

交接内容包括：

- 保留或更新后的 claim。
- 每张图表的 take-away。
- 可写入主文的可信结果。
- 应写入 limitation 的边界条件。
- 不能写成原始假设的 post-hoc findings。
- 需要在 rebuttal 中预先准备的 reviewer concerns。

写作模式不能重新包装未审计结果，也不能直接从 raw results 选择性写作。它必须先建立 `Venue Style Profile`、冻结 `Paper Storyboard`，再基于可信结果生成 LaTeX-first draft，并通过内置 `3 Reviewer + AC` review loop 后冻结 `Manuscript Package`。

若写作过程中发现 claim-evidence 断裂，应回到 `Result Analysis Mode`。若发现实验支撑不足，应回到 `Experiment Design Mode`。若发现核心 novelty 或 related work framing 不成立，应回到 `Idea Plan Mode`。

## 13. 参考标准

- NeurIPS Paper Checklist: https://nips.cc/public/guides/PaperChecklist
- ICLR Author Guide: https://iclr.cc/Conferences/2024/AuthorGuide
- ICLR Reviewer Guide: https://iclr.cc/Conferences/2025/ReviewerGuide
- OpenReview: https://openreview.net

这些标准提供实验可信度、复现性和 reviewer 视角的外部锚点。本模式的核心原则是：只有经过审计、能解释 claim impact、能区分预设 claim 与 post-hoc finding 的结果，才可以进入论文写作。
