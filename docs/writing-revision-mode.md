# 学术 Agent Writing / Revision Mode 设计规范

## 1. 目标与角色定位

`Writing / Revision Mode` 是学术 agent 中用于把已审计研究结果写成目标 venue 论文的写作与修改模式。它接在结果分析之后：

```text
ResearchIdeaPlan frozen
-> Experiment Blueprint frozen
-> Execution Package frozen
-> Result Analysis Report frozen
-> Manuscript Package frozen
-> Submission / Rebuttal / Camera-ready
```

它的核心角色是：

> 论文叙事架构师 + 证据守门员 + 目标会议风格编辑

它不是普通润色器，也不是把实验结果包装得更好看的写作助手。它负责把 frozen `ResearchIdeaPlan`、frozen `Result Analysis Report`、关键 related work 和目标会议风格组织成一篇证据边界清楚、claim 强度合适、reviewer 风险可见的学术论文。

### 1.1 核心职责

- 学习目标 venue 的写作风格、结构偏好、reviewer 关注点和格式约束。
- 先冻结 `Paper Storyboard`，再进入分节写作。
- 将 `Result Analysis Report` 中的可信结论映射到论文 claim、图表、实验叙事和 limitations。
- 检查 abstract、introduction、conclusion 是否存在 unsupported claim 或 overclaim。
- 组织 related work 和 citation audit，暴露 novelty risk 和 missing citation。
- 生成和维护 LaTeX-first paper draft。
- 内置 pre-submission review loop，使用 `3 Reviewer + AC` 攻击论文。
- 冻结 `Manuscript Package`，供投稿、rebuttal 或 camera-ready 阶段使用。

### 1.2 非目标

- 不重新定义 idea、主 claim 或核心机制；这些属于 `Idea Plan Mode`。
- 不重新设计实验；claim-evidence 断裂时回到 `Experiment Design Mode` 或 `Result Analysis Mode`。
- 不直接使用 raw results 写论文。
- 不把 `Invalid`、未审计或缺日志的结果包装成证据。
- 不伪造引用、实验、数字、图表、用户研究或 reviewer 反馈。
- 不把目标会议风格学习变成抄写范文表达。

### 1.3 语气与权力边界

- Agent 应直接指出 overclaim、novelty risk、evidence gap、venue mismatch 和 citation gap。
- 用户保留叙事偏好和投稿 venue 的选择权。
- Agent 不能把不满足证据门槛的 draft 标记为 `Ready`。
- 如果用户坚持写入强 claim，agent 必须标注它是 unsupported 或 speculative，且不能冻结为 submission-ready `Manuscript Package`。

## 2. 启动条件与输入

`Writing / Revision Mode` 的正式启动条件是存在 frozen `Result Analysis Report`。如果用户只有 raw results、主表、实验截图或非审计结论，只能做 provisional writing inspection，不能冻结 `Manuscript Package`。

### 2.1 最低输入

正式启动需要：

- `ResearchIdeaPlan`: frozen idea、主 claim、机制、贡献类型和 novelty risk。
- `Experiment Blueprint`: claim-evidence map、baseline、metric、ablation 和 human evaluation 设计。
- `Result Analysis Report`: 可信结果、claim impact、图表 take-away、limitations、post-hoc findings 和 reviewer concerns。
- `Key Paper Mini-reviews`: 关键论文、近邻工作、innovation hooks 和 novelty risk。
- `Target Venue`: 会议/期刊名称、年份、track、页数和匿名要求。
- `Venue Materials`: template、CFP、author guide、reviewer guide、ethics/reproducibility checklist。
- `Author Constraints`: 想强调的贡献、不能公开的数据/模型、可补实验范围、投稿时间线。

### 2.2 Provisional Writing

如果 target venue 或 frozen `Result Analysis Report` 缺失，agent 只能输出 provisional artifact：

```markdown
Status: Provisional
Missing Inputs:
Allowed Work:
Cannot Freeze Because:
Required Before Formal Writing:
```

Provisional writing 可以帮助用户梳理 story，但不能生成 submission-ready 结论，也不能进入正式 review loop 的 `Ready` 决策。

### 2.3 反向门禁

写作过程中发现以下问题，应回退：

| 问题类型 | 回退目标 |
| --- | --- |
| 结果未审计、图表 take-away 不可信、claim impact 不清楚 | `Result Analysis Mode` |
| 实验无法支撑论文叙事、baseline/metric/ablation 缺口影响主 claim | `Experiment Design Mode` |
| novelty framing 不成立、关键 related work 未读、idea 贡献被近邻工作覆盖 | `Idea Plan Mode` |
| 只是局部 citation、表述、结构或 venue fit 问题 | 留在 `Writing / Revision Mode` 修复 |

## 3. 核心哲学：先定 Story，再写 Paper

写作不是把所有材料线性拼起来，而是建立一条可被 reviewer 接受的叙事链：

```text
Problem -> Gap -> Mechanism -> Evidence -> Boundary -> Contribution
```

每个 section 都必须服务这条链。写作模式必须先确认：

- 论文要让 reviewer 相信的 central claim 是什么。
- 这个 claim 的证据来自哪些可信实验或分析。
- 哪些结果只能支持 narrow claim。
- 哪些发现是 post-hoc，不能伪装成原始假设。
- 哪些限制必须主动写出，否则会被 reviewer 攻击。

### 3.1 证据硬门禁

以下内容不能写入核心贡献、abstract 或 conclusion：

- `Invalid` 实验结果。
- 未审计 raw result。
- 没有 baseline 或统计支持的性能 claim。
- 只是 post-hoc 观察但被写成预设 claim 的结论。
- 与 `Result Analysis Report` 冲突的强叙事。
- 没有读过或未验证的 related work 对比。

允许的处理方式：

- 收窄 claim。
- 写入 limitations。
- 放入 future work。
- 回到结果分析补证据。
- 回到实验设计补实验。
- 回到 idea plan 重构贡献。

### 3.2 Claim-Writing 对齐

论文中的每个强 claim 都必须能追溯到证据：

```text
Claim in paper
-> Source in Result Analysis Report
-> Figure / Table / Analysis
-> Support strength
-> Limitation / caveat
```

如果无法建立这条链，claim 只能作为 hypothesis、future work 或删除。

## 4. Venue Style Profile

正式写作前，agent 必须建立 `Venue Style Profile`。目标不是复制某篇论文，而是学习目标 venue 对贡献、结构、证据和表达的偏好。

### 4.1 信息来源

优先级如下：

1. 官方 template、author guide、CFP、reviewer guide。
2. 官方 ethics、reproducibility、checklist 或 artifact policy。
3. 近年 accepted papers，优先选择同 track、同主题、同贡献类型论文。
4. 用户指定的 style reference papers。
5. 本地已有 paper draft、lab template 或导师偏好。

对时效性强的 venue 信息，agent 应检索并使用官方来源确认；不能凭旧记忆假定当前年份规则。

### 4.2 输出字段

```markdown
# Venue Style Profile

## Venue
- Name / Year / Track:
- Page Limit:
- Anonymity:
- Template:
- Checklist:

## Contribution Preference
- Favored Contribution Types:
- Common Rejection Risks:
- Expected Evidence Standard:

## Structure Pattern
- Typical Section Order:
- Introduction Pattern:
- Method Detail Level:
- Experiment Narrative Style:
- Related Work Density:

## Style Constraints
- Tone:
- Claim Strength:
- Math / Algorithm / Figure Expectations:
- Reproducibility / Ethics Expectations:

## Reference Papers Used
| Paper | Venue/Year | Why Relevant | Style Feature Learned |
| --- | --- | --- | --- |

## Do Not Imitate
- Phrases or framing that should not be copied:
- Mismatches with our paper:
```

### 4.3 Venue Fit 判断

如果 paper 与 target venue 不匹配，agent 应输出：

```markdown
Venue Fit: [Strong / Plausible / Weak / Mismatch]
Main Fit Reason:
Main Mismatch:
Required Change:
Alternative Venue:
```

`Weak` 或 `Mismatch` 不一定阻止写作，但不能忽略；若 mismatch 来自贡献类型或证据标准，应回到 `Idea Plan Mode` 或 `Experiment Design Mode`。

## 5. Paper Storyboard

正文起草前必须冻结 `Paper Storyboard`。Storyboard 是写作模式的计划性产物，不是最终论文。

### 5.1 Storyboard 模板

```markdown
# Paper Storyboard: [Working Title]

## Status
- Version:
- Status: [Draft / Frozen]
- Target Venue:
- Linked ResearchIdeaPlan:
- Linked Result Analysis Report:

## Thesis
- One-sentence Thesis:
- Central Claim:
- Claim Strength: [Strong / Moderate / Narrow / Exploratory]
- Main Reviewer Risk:

## Contributions
1.
2.
3.

## Narrative Arc
- Problem:
- Gap:
- Key Insight:
- Method Mechanism:
- Evidence:
- Boundary / Limitation:
- Why It Matters:

## Claim-Evidence Alignment
| Paper Claim | Evidence Source | Figure/Table | Strength | Caveat |
| --- | --- | --- | --- | --- |

## Section Plan
| Section | Purpose | Key Claims | Required Evidence | Risk |
| --- | --- | --- | --- | --- |

## Figure / Table Plan
| Artifact | Purpose | Claim Supported | Source | Take-away |
| --- | --- | --- | --- | --- |

## Related Work Positioning
- Closest Work:
- How We Differ:
- Novelty Risk:
- Missing Citation:

## Limitations to State
-

## User Confirmation
- Confirmed By:
- Date:
- Required Changes Before Drafting:
```

### 5.2 用户确认门槛

用户确认 storyboard 前，agent 不应进入完整正文起草。允许做的工作包括：

- 生成标题候选。
- 重写 thesis。
- 讨论 section order。
- 做 citation audit。
- 检查 claim-evidence map。

确认后，agent 才按 section 进入 LaTeX-first drafting。

## 6. 分节到整稿写作规范

正式 paper draft 默认使用 LaTeX。Markdown 可用于 storyboard、review log、revision record 和 checklist。

### 6.1 Section 顺序

默认顺序：

1. Title
2. Abstract
3. Introduction
4. Related Work
5. Method
6. Experiments
7. Results and Analysis
8. Limitations
9. Conclusion

具体 section 名称可按 venue 和论文类型调整，但每个 section 都必须有明确功能。

### 6.2 Section Drafting Checklist

```markdown
## Section Drafting Checklist

- Section:
- Purpose:
- Claims Introduced:
- Evidence Required:
- Citations Required:
- Terms / Notation Introduced:
- Figures / Tables Referenced:
- Unsupported Claims:
- Venue Style Issues:
- Revision Needed:
```

### 6.3 Title

Title 应具体、可检索、能表达任务和核心机制。避免：

- 只有系统名或缩写。
- "Towards" 滥用。
- 过度营销式形容词。
- 无法判断研究对象的宽泛标题。

### 6.4 Abstract

Abstract 必须自洽，不放 citation，不引入未定义缩写。默认包含：

- Problem。
- Gap。
- Method 或 insight。
- Key result，必须来自 `Result Analysis Report`。
- Contribution 和 limitation 边界。

如果结果只支持 narrow claim，abstract 必须使用 narrow claim。

### 6.5 Introduction

Introduction 应在第一页内回答：

- 为什么问题重要。
- 现有方法缺什么。
- 本文核心 insight 是什么。
- 方法如何实现 insight。
- 结果支持到什么程度。
- 本文贡献是什么。

贡献列表不得包含没有证据的贡献。若贡献是 benchmark、analysis、negative result 或 human-agent workflow，必须清楚说明为什么它具有学术价值，而不是工程拼装。

### 6.6 Related Work

Related Work 应按主题组织，不按论文流水账排列。每个主题段落应说明：

- 这类工作解决了什么。
- 它们和本文的关系。
- 本文与它们的差异。
- 它们带来的 novelty risk。

关键近邻工作必须出现在 related work 中，并在 introduction 或 method 中保持一致引用。

### 6.7 Method

Method 应按读者理解顺序展开：

- Problem formulation。
- Notation。
- Core mechanism。
- Algorithm / objective / model。
- Implementation-relevant details。
- Why the mechanism should address the gap。

Method 不应偷偷加入 experiment design 中没有验证过的新机制。若写作时发现机制解释需要改变，应回到 `Idea Plan Mode` 或 `Experiment Design Mode`。

### 6.8 Experiments

Experiments 应以 research questions 或 hypotheses 开头，而不是直接堆 dataset 和 metric。默认包含：

- RQ / hypothesis。
- Dataset 和 task。
- Baselines。
- Metrics。
- Implementation details。
- Statistical protocol。
- Main results。
- Ablation。
- Mechanism / diagnostic analysis。
- Robustness / generalization。
- Human evaluation。
- Cost and resource reporting。

这些内容必须和 `Experiment Blueprint`、`Execution Package`、`Result Analysis Report` 一致。

### 6.9 Results and Analysis

结果写作只能来自已审计结论：

| Result Class | 写作方式 |
| --- | --- |
| `Support` | 可写为证据，但必须带范围和条件 |
| `Weaken` | 写为边界、限制或需要补实验的现象 |
| `Falsify` | 不能包装成成功；应回退或转为负结果论文叙事 |
| `Inconclusive` | 写为未能确认，不支撑主 claim |
| `Invalid` | 不进入论文证据，只能作为执行问题记录 |

每张图表必须有一句 take-away：

```markdown
Figure/Table:
Claim Supported:
Take-away:
Evidence Strength:
Caveat:
```

### 6.10 Limitations

Limitations 不是客套话，而是 reviewer 风险的主动管理。应包括：

- 数据、任务、domain 或人群边界。
- 统计和 seed 稳定性边界。
- baseline 或复现限制。
- human evaluation 样本和偏差。
- 计算成本和可扩展性。
- 伦理、安全和 misuse 风险。

### 6.11 Conclusion

Conclusion 只总结已建立的贡献和边界，不引入新实验、新 claim 或未讨论的未来方向。

## 7. Citation Audit 与 Related Work 门禁

写作模式必须执行 citation audit，防止论文在 novelty 和定位上被 reviewer 击穿。

### 7.1 Citation Audit Checklist

```markdown
# Citation Audit

## Coverage
- Seminal Work Covered:
- Closest Recent Work Covered:
- Venue-specific Expected Citations:
- Dataset / Benchmark Citations:
- Method / Baseline Citations:
- Evaluation / Human Study Citations:

## Novelty Risk
| Related Work | Overlap | Difference Claimed | Evidence | Risk |
| --- | --- | --- | --- | --- |

## Missing or Weak Citations
| Claim / Sentence | Missing Source | Severity | Action |
| --- | --- | --- | --- |

## Decision
- Citation Status: [Pass / Minor Gap / Major Gap / Fatal Gap]
- Required Action:
- Backtrack Needed:
```

### 7.2 回退规则

- `Minor Gap`: 可在 Writing Mode 内补 citation 或重写 related work。
- `Major Gap`: 暂停正文冻结，补读论文并更新 mini-review。
- `Fatal Gap`: 如果核心 novelty 被覆盖，回到 `Idea Plan Mode`。

## 8. 内置 Review Loop

`Writing / Revision Mode` 内置 pre-submission review loop。它不是模拟真实录用结果，而是暴露 submission risk。

### 8.1 Review 触发点

必须在以下节点触发 review：

- `Paper Storyboard` 冻结前。
- 完整 draft 完成后。
- `Manuscript Package` 冻结前。
- Rebuttal 或 camera-ready 重大修改后。

### 8.2 Reviewer 角色

默认使用 `3 Reviewer + AC`：

| 角色 | 重点 |
| --- | --- |
| Novelty Reviewer | originality、近邻工作、贡献是否顶会级 |
| Soundness Reviewer | 方法、实验、统计、claim-evidence、可复现性 |
| Clarity / Positioning Reviewer | 叙事、结构、术语、venue fit、读者理解 |
| AC Meta-review | 汇总风险、排序修改、决定 readiness |

### 8.3 Internal Reviewer Report 模板

```markdown
# Internal Reviewer Report

## Reviewer Role
- Role:
- Confidence:

## Summary
-

## Strengths
-

## Major Weaknesses
-

## Minor Weaknesses
-

## Claim-Evidence Issues
-

## Venue Fit Issues
-

## Required Revisions
-

## Decision
- Label: [Ready / Minor Revision / Major Revision / Backtrack]
- Rationale:
```

### 8.4 AC Meta-review 模板

```markdown
# AC Meta-review

## Overall Readiness
- Label: [Ready / Minor Revision / Major Revision / Backtrack]
- Confidence:

## Main Blocking Issues
1.
2.
3.

## Reviewer Disagreement
- Point:
- Evidence:
- Resolution:

## Revision Priorities
| Priority | Issue | Required Change | Owner | Backtrack Target |
| --- | --- | --- | --- | --- |

## Final Gate
- Can Freeze Manuscript Package: [yes / no]
- If No, Required Mode:
```

### 8.5 判定标签

| 标签 | 含义 | 后续 |
| --- | --- | --- |
| `Ready` | 证据、叙事、格式和 venue fit 达到投稿前内部标准 | 可冻结 `Manuscript Package` |
| `Minor Revision` | 局部表达、结构、citation 或 clarity 问题 | 留在 Writing Mode 修改 |
| `Major Revision` | claim、结构、related work 或实验叙事有重大缺口 | 修改后重跑 review |
| `Backtrack` | 问题不属于写作可修复范围 | 回到 Result Analysis / Experiment Design / Idea Plan |

不得使用 `Accept / Reject` 伪装真实审稿结果。

## 9. Revision / Rebuttal / Camera-ready

Writing / Revision Mode 支持三个子阶段，但每个阶段的输入和目标不同。

### 9.1 Pre-submission Writing

目标是冻结投稿前 `Manuscript Package`。重点：

- 论文叙事完整。
- claim-evidence 对齐。
- citation audit 通过。
- review loop 无 blocking issue。
- venue checklist 可提交。

### 9.2 Rebuttal Writing

Rebuttal 必须基于真实 reviewer comments 和已有证据。原则：

- 专业、具体、非防御性。
- 先承认合理问题，再给证据或修改承诺。
- 不承诺无法完成的补实验。
- 不把 reviewer concern 简化成误解；先判断是否是论文表达或证据问题。
- 能做的新增实验必须说明规模、结果、写入位置和完成状态。

Rebuttal 模板：

```markdown
# Rebuttal Plan

## Reviewer Concern
- Reviewer:
- Concern:
- Severity:
- Is the Concern Valid:

## Evidence Available
- Existing Evidence:
- New Analysis Possible:
- Cannot Address Because:

## Response Draft
-

## Manuscript Change
- Section:
- Change:
- Status:
```

### 9.3 Camera-ready Revision

Camera-ready 阶段处理：

- 匿名信息恢复。
- reviewer 承诺兑现。
- appendix、supplementary、artifact 和 main paper 一致性。
- checklist 更新。
- citation、figure、table、label、cross-reference 检查。
- final limitation、ethics、reproducibility statement。

Camera-ready 不能新增未经审计的强 claim。

## 10. Manuscript Package 模板

```markdown
# Manuscript Package: [Title]

## Status
- Version:
- Status: [Draft / Frozen]
- Target Venue:
- Stage: [Pre-submission / Rebuttal / Camera-ready]
- Linked ResearchIdeaPlan:
- Linked Experiment Blueprint:
- Linked Execution Package:
- Linked Result Analysis Report:

## Venue Style Profile
- Profile Link / Summary:
- Venue Fit: [Strong / Plausible / Weak / Mismatch]
- Required Checklist:

## Paper Storyboard
- Storyboard Status:
- Central Claim:
- Contribution List:
- Claim Strength:

## Draft Artifacts
- Main LaTeX:
- Bibliography:
- Figures:
- Tables:
- Appendix / Supplementary:
- Artifact / Code Link:

## Claim-Writing Map
| Claim | Section | Evidence | Figure/Table | Strength | Caveat |
| --- | --- | --- | --- | --- | --- |

## Citation Audit
- Status: [Pass / Minor Gap / Major Gap / Fatal Gap]
- Remaining Risks:

## Internal Review
- Latest Reviewer Reports:
- AC Label: [Ready / Minor Revision / Major Revision / Backtrack]
- Blocking Issues:

## Revision Record
| Version | Change | Reason | Evidence / Review Source |
| --- | --- | --- | --- |

## Submission Checklist
- Anonymous Compliance:
- Page Limit:
- Formatting:
- Ethics Statement:
- Reproducibility Statement:
- Limitations:
- Artifact Consistency:
- Unsupported Claims Removed:

## Freeze Decision
- Decision: [Freeze / Revise / Backtrack]
- Confidence:
- Next Stage:
```

## 11. 示例：Academic Agent Idea 的写作与审稿

### 11.1 输入状态

假设 `Result Analysis Report` 对 academic agent idea 给出：

- 原始强 claim: "co-reading agent improves top-tier research idea generation."
- 更新后 narrow claim: "structured human-agent co-reading improves novelty-risk awareness and claim-evidence alignment for early-stage researchers."
- 主结果: 用户在 idea review 中更少遗漏近邻工作，claim-evidence map 完整度提升。
- 边界: 专家用户收益较小；idea originality 本身提升证据不足。
- human evaluation: reviewer-rated originality 无显著提升，但 soundness 和 clarity 有提升。

### 11.2 Storyboard 重构

不能写成：

```text
Our agent substantially improves research creativity.
```

应写成：

```text
We study whether structured human-agent co-reading can help early-stage researchers identify novelty risks and align research claims with evidence before experiment design.
```

贡献列表应收窄为：

1. 一个面向 early-stage AI research ideation 的 human-agent co-reading protocol。
2. 一个把论文阅读、innovation hooks 和 claim-evidence map 连接起来的 idea planning workflow。
3. 对 novelty-risk awareness 和 claim-evidence alignment 的用户研究与错误分析。

### 11.3 实验叙事

实验 section 不应只报告主表，而应按 RQ 写：

- RQ1: co-reading 是否减少 novelty risk 漏检？
- RQ2: co-reading 是否提升 claim-evidence map 完整度？
- RQ3: 哪些用户或任务条件下收益有限？

如果 reviewer-rated originality 没有显著提升，应写为：

```text
The intervention improves researchers' ability to audit and refine ideas, but does not by itself provide evidence that it increases the intrinsic originality of the final ideas.
```

### 11.4 Internal Review 发现

Novelty reviewer:

- 风险: "academic agent for literature review" 已有大量近邻工作。
- 修改: 必须把贡献从 general literature review agent 收窄到 claim-evidence aligned ideation protocol。

Soundness reviewer:

- 风险: human evaluation 样本量小，不能支持 broad creativity claim。
- 修改: abstract 和 conclusion 删除 broad creativity 表述。

Clarity reviewer:

- 风险: "idea quality" 定义过宽。
- 修改: 引入三个可测维度：novelty-risk awareness、claim-evidence alignment、reviewer-facing clarity。

AC meta-review:

```markdown
Overall Readiness: Major Revision
Blocking Issues:
1. Abstract still overclaims idea creativity.
2. Related work does not sufficiently distinguish co-reading from generic literature review agents.
3. Limitations need to state expert-user ceiling effect.
Backtrack Needed: no
```

修改后若所有强 claim 都被收窄到可信证据范围内，可进入 `Ready` 并冻结 `Manuscript Package`。

## 12. 交接与回流

### 12.1 从 Result Analysis 接收

Writing / Revision Mode 接收的是 frozen `Result Analysis Report`，不是 raw result 或主表截图。接收内容必须包括：

- 更新后的 claim。
- 每张图表的 take-away。
- 可写入主文的可信结果。
- 应写入 limitation 的边界条件。
- 不能写成原始假设的 post-hoc findings。
- reviewer concerns。

### 12.2 向后交接

冻结 `Manuscript Package` 后，可进入：

- `Submission`: 按 venue 要求准备投稿材料。
- `Rebuttal`: 基于真实 reviewer comments 写 response。
- `Camera-ready`: 兑现修改承诺并统一最终稿、appendix 和 artifact。

### 12.3 回流

如果 Writing / Revision Mode 发现问题无法通过写作修复：

- 结果可信度问题回到 `Result Analysis Mode`。
- 实验支撑不足回到 `Experiment Design Mode`。
- 核心 novelty 或 idea 贡献问题回到 `Idea Plan Mode`。

## 13. 参考原则

- NeurIPS / ICML / ICLR 类 venue 通常重视清晰问题、算法或机制贡献、严格实验和 claim-evidence 对齐。
- ACL / EMNLP 类 venue 通常要求更充分的 related work、语言任务定位、错误分析和人评细节。
- CVPR 类 venue 通常要求图像/视觉结果和 qualitative analysis 清楚服务 claim。
- KDD / WWW / SIGIR 类 venue 通常更强调问题重要性、数据规模、部署/效率、用户或系统影响。

这些只是 venue 风格倾向。正式写作时必须以目标年份官方材料、模板、reviewer guide 和相关 accepted papers 为准。
