# 学术 Agent Execution Plan Mode 设计规范

## 1. 目标与角色定位

`Execution Plan Mode` 是学术 agent 中用于把 frozen `Experiment Blueprint` 转成可执行、可测试、可复现、可审计实验过程的研究工程模式。它位于实验设计和结果分析之间：

```text
ResearchIdeaPlan frozen
-> Experiment Blueprint frozen
-> Execution Package frozen
-> Result Analysis Report frozen
-> Manuscript Package frozen
-> Submission / Rebuttal / Camera-ready
```

它的核心角色是：

> 研究工程师 + 复现守门员

它不是单纯的 `Coding Mode`。完成标准不是“代码写完”或“实验跑完”，而是冻结一个完整 `Execution Package`，让 `Result Analysis Mode` 能审计结果、解释 claim impact，并追溯配置、seed、日志、失败和偏离。

### 1.1 核心职责

- 将 frozen `Experiment Blueprint` 拆成可验证的执行任务。
- 实现实验代码、数据处理、评测、baseline、ablation、日志和结果导出。
- 通过 TDD 和行为测试保护关键代码路径。
- 记录配置、seed、数据版本、模型/API 版本、运行日志、资源成本和失败记录。
- 控制执行偏离，不私自修改实验蓝图。
- 冻结 `Execution Package`，交给 `Result Analysis Mode`。

### 1.2 非目标

- 不重新定义 idea 或 claim。
- 不私自修改 `Experiment Blueprint` 中的 baseline、metric、ablation 或实验条件。
- 不负责结果的学术解释；结果解释属于 `Result Analysis Mode`。
- 不把 notebook 临时运行、手工记录或单张结果表当成完整执行产物。

### 1.3 语气与权力边界

- Agent 应直接指出执行不可复现、不可审计或偏离蓝图的地方。
- Agent 可以执行普通实现和小规模验证。
- 大算力、付费 API、长时间任务、私有数据或可能暴露敏感信息的运行必须先获得用户显式批准。

## 2. 启动条件与输入

`Execution Plan Mode` 只有在 frozen `Experiment Blueprint` 之后启动。若实验蓝图仍处于 `Draft / Revise / Provisional`，应先回到 `Experiment Design Mode`。

### 2.1 最低输入

启动前必须具备：

- `Experiment Blueprint`: 冻结后的实验蓝图。
- `Repo State`: 代码库路径、分支/worktree 状态、已有测试和构建方式。
- `Data Access`: 数据路径、许可、下载方式、隐私/合规约束。
- `Compute Environment`: GPU/CPU/API/存储/运行时长约束。
- `Verification Commands`: 测试、构建、smoke run、small-scale run 的验收命令。
- `Artifact Format`: 日志、结果表、run manifest、failure/deviation records 的格式。

缺任何关键输入时，agent 应暂停并要求补充，不能靠猜。

### 2.2 反向门禁

执行中发现以下问题，应退回 `Experiment Design Mode`：

- baseline、metric 或 ablation 在工程上不可实现。
- 数据不可访问或许可不允许使用。
- 算力无法完成 must-have 实验。
- 运行方式会改变实验条件，从而影响 claim-evidence map。
- 蓝图没有定义必要的日志、结果或验收标准。

执行者不能私自改蓝图来“让代码跑起来”。偏离必须记录并按等级处理。

## 3. 工作区与基线验证

### 3.1 隔离工作区优先

实现前应检测当前工作区状态：

- 是否为 git 仓库。
- 是否在 main/master 或普通分支。
- 是否已经在 isolated worktree。
- 是否有未提交或未知改动。

原则：

- 优先使用隔离分支或 worktree。
- 不在 main/master 上直接实现，除非用户明确同意。
- 不覆盖、不回滚、不清理用户已有改动。
- 如果仓库不支持 worktree 或当前目录不是正常 git 仓库，应记录该限制，并在当前工作区谨慎执行。

### 3.2 脏工作区处理

若存在已有改动：

```markdown
### Pre-existing Changes

- Files:
- Owner / Likely Source:
- Related to Current Execution: [yes / no / unknown]
- Protection Action:
```

不相关改动应避免触碰。相关但不清楚的改动应要求用户确认。

### 3.3 Baseline Verification

开始编码前必须运行 baseline verification：

- 现有测试。
- 构建或静态检查。
- 最小数据/配置健康检查。
- 若项目没有测试，至少运行可用的导入、CLI help、配置加载或 smoke check。

如果 baseline 已失败，必须记录为 pre-existing failure，并询问是否继续、先修复，或退回计划。

## 4. TDD 与测试规范

### 4.1 默认 TDD

行为代码默认 test-first：

- 数据加载和预处理。
- 评测指标。
- 实验 pipeline。
- 日志和结果导出。
- baseline wrapper。
- 核心算法或机制实现。
- 配置解析和 run manifest 生成。

TDD 循环：

```text
RED: 写一个行为测试并确认失败
GREEN: 写最小实现让它通过
REFACTOR: 在测试保持通过时清理结构
```

不允许先写一堆实现再补测试。若因配置、一次性脚本或探索 notebook 需要例外，必须记录原因。

### 4.2 测试风格

测试应优先验证行为，而不是实现细节：

- 通过 public interface 测试。
- 使用小样本 fixture。
- 尽量走真实数据处理和评测路径。
- 测试名称描述“系统应该做什么”。
- 避免断言内部函数调用顺序、私有方法或内部模块结构。

### 4.3 Mock 策略

只 mock 系统边界：

- 外部 API。
- 时间和随机性。
- 文件系统或数据库边界。
- 不稳定网络资源。

不要 mock 自己的内部模块。内部模块应通过公共接口或集成式测试验证。

### 4.4 测试例外记录

```markdown
### Test Exception

- Component:
- Why TDD / automated test is impractical:
- Alternative verification:
- Risk:
- Follow-up:
```

例外不能成为主路径无测试的借口。

## 5. 任务拆分与 Tracer Bullet

### 5.1 垂直切片

任务应按可验证能力拆分，而不是按文件横切。推荐顺序：

1. 数据加载和 fixture。
2. 最小 baseline 跑通。
3. 主方法最小实现。
4. 评测指标。
5. 结构化日志和 run manifest。
6. Ablation 开关。
7. 结果导出。
8. Smoke/small/full run 编排。

每个任务都应有明确验收命令和输出。

### 5.2 Tracer Bullet

正式扩展前必须先跑通最小闭环：

```text
small data -> method/baseline -> evaluation -> logging -> result artifact
```

Tracer bullet 目标不是得到有意义的学术结果，而是证明执行管线可用、日志可追踪、结果可导出。

### 5.3 任务模板

```markdown
### Execution Task: [Name]

- Linked Blueprint Section:
- Behavior to Implement:
- Test First:
- Minimal Implementation:
- Verification Command:
- Expected Artifact:
- Review Required: [spec / quality / both]
```

## 6. 配置、日志与结果包

### 6.1 配置即证据

每次运行必须保存完整配置：

- Experiment ID。
- Git commit / branch / worktree state。
- Environment。
- Seed。
- Data version。
- Model/API version。
- Hyperparameters。
- Prompt/template version if applicable。
- Compute resource。
- Command line。
- Timestamp。

配置不能只存在于命令历史或聊天记录中。

### 6.2 结构化日志

日志应记录：

- Run start/end。
- Config hash。
- Step status。
- Metrics。
- Warnings。
- Exceptions。
- Failure reason。
- Resource cost。
- Output paths。
- Deviation from blueprint。

推荐以 JSONL、CSV、structured YAML 或项目已有结构化格式保存。普通文本日志可以辅助阅读，但不能替代结构化日志。

### 6.3 标准结果包

`Execution Package` 至少包含：

- Code changes。
- Configs。
- Run manifests。
- Raw outputs。
- Metrics。
- Summary tables。
- Logs。
- Failure records。
- Deviation records。
- Verification evidence。
- Reproduction notes。

## 7. 实验运行策略

### 7.1 三阶段运行

| 阶段 | 目的 | 要求 |
| --- | --- | --- |
| `smoke run` | 验证代码路径可运行 | 极小数据、极短时间、完整日志 |
| `small-scale validation` | 验证指标、baseline、ablation 和结果包结构 | 小规模但真实流程 |
| `full run` | 生成正式结果 | 需要资源批准和完整记录 |

禁止直接从未验证代码进入 full run。

### 7.2 失败处理

失败必须记录并分类：

| 类型 | 示例 | 处理 |
| --- | --- | --- |
| 环境问题 | 依赖、CUDA、权限 | 修环境或记录限制 |
| 代码问题 | bug、接口错误 | TDD 修复并回归测试 |
| 数据问题 | 缺文件、格式错、许可限制 | 修数据路径或回退蓝图 |
| 资源问题 | 显存、时间、API 预算 | 降规模或请求资源确认 |
| 蓝图问题 | baseline/metric 不可实现 | 回到 `Experiment Design Mode` |

### 7.3 Failure Record

```markdown
### Failure Record

- Run ID:
- Stage: [smoke / small-scale / full]
- Failure Type:
- Symptom:
- Root Cause:
- Artifacts:
- Fix / Decision:
- Requires Blueprint Change: [yes / no]
```

### 7.4 Deviation Record

执行偏离蓝图时必须记录：

```markdown
### Deviation Record

- Run ID:
- Blueprint Requirement:
- Actual Execution:
- Reason:
- Impact on Claim: [None / Minor / Major / Fatal]
- Approved By:
- Follow-up:
```

`Major / Fatal` 偏离必须回到 `Experiment Design Mode` 确认。

## 8. 资源与权限门禁

### 8.1 需要显式批准的动作

- 长时间训练或评测。
- 大算力 GPU/云 GPU。
- 付费 API 或高 token 成本。
- 私有数据、敏感数据或不可公开数据。
- 向外部服务上传未发表 idea、数据或模型输出。
- 会产生不可逆成本或副作用的任务。

批准前应说明：

- 预计时间。
- 预计成本。
- 数据暴露风险。
- 可复现风险。
- 替代方案。
- 中断和恢复方式。

### 8.2 长任务要求

长任务必须支持：

- Checkpoint。
- Resume。
- Structured logs。
- Partial result preservation。
- Failure recovery。
- Resource usage tracking。

不应在前台裸跑长任务并丢失上下文。

## 9. Review 与完成标准

### 9.1 每任务 Review

每个 execution task 完成后：

1. Implementer self-review。
2. Spec compliance review。
3. Code quality review。

Spec compliance review 必须先于 code quality review。

### 9.2 Spec Compliance Review

检查：

- 是否符合 `Experiment Blueprint`。
- 是否只实现任务要求，不多不少。
- 是否产生要求的 artifact。
- 是否记录配置、日志、失败和偏离。
- 是否有未批准的蓝图偏离。

### 9.3 Code Quality Review

检查：

- 文件职责是否清晰。
- 接口是否稳定且可测试。
- 测试是否验证行为。
- 是否过度 mock 内部模块。
- 是否过度工程化。
- 是否遵循项目现有模式。
- 是否能维护和复现。

### 9.4 Fresh Verification

完成前必须重新运行指定验证命令，并读取输出后才能声明完成：

- Tests。
- Build/static checks。
- Smoke run。
- Small-scale validation。
- Artifact existence checks。
- Result package schema checks。

不能用“之前跑过”“应该通过”“review 通过了”替代 fresh verification。

## 10. Execution Package 模板

```markdown
# Execution Package: [Title]

## Version

- Linked Experiment Blueprint:
- Status: [Draft / Frozen]
- Decision: [Complete / Blocked / Needs Blueprint Revision]
- Confidence:

## Workspace

- Repo:
- Branch / Worktree:
- Git Commit:
- Pre-existing Changes:
- Baseline Verification:

## Implementation Summary

- Tasks Completed:
- Code Changes:
- Tests Added:
- Interfaces / Commands:

## Run Manifests

| Run ID | Stage | Config | Seed | Data Version | Model/API Version | Status | Output Path |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | |

## Artifacts

- Configs:
- Raw Outputs:
- Metrics:
- Summary Tables:
- Logs:
- Failure Records:
- Deviation Records:

## Verification Evidence

- Test Command:
- Test Output Summary:
- Smoke Run:
- Small-scale Validation:
- Artifact Checks:

## Handoff to Result Analysis

- Complete Result Artifacts:
- Known Failures:
- Known Deviations:
- Reproducibility Notes:
- Result Analysis Entry Point:
```

## 11. 示例：Academic Agent 实验执行

### 11.1 Frozen Experiment Blueprint 摘要

主实验：

> 比较 `co-reading mode` 与 ordinary LLM brainstorming、RAG literature summary、multi-agent reviewer/planner workflow、human-only reading notes 在 research idea 质量上的差异。

核心产物：

- 生成的 candidate ideas。
- Human evaluation scores。
- Novelty-risk awareness metrics。
- Claim-evidence alignment scores。
- Ablation 结果。

### 11.2 Tracer Bullet

最小闭环：

```text
2 个 toy research topics
-> 2 个 baseline modes
-> 生成少量 candidate ideas
-> 运行 mock human-eval fixture 或离线 evaluator
-> 输出 metrics + run manifest + logs
```

通过标准：

- 每个 run 有唯一 run ID。
- 每个 run 保存完整 config 和 seed。
- 结果表能关联 topic、mode、idea、metric。
- 日志记录开始/结束、错误和输出路径。

### 11.3 垂直任务切片

1. 数据和 topic fixture。
2. Baseline mode runner。
3. Co-reading mode runner。
4. Metric computation。
5. Ablation flags。
6. Structured logging。
7. Run manifest。
8. Result package export。
9. Smoke/small-scale/full run commands。

### 11.4 运行分层

- `smoke run`: 2 topics、2 modes、fixture evaluator。
- `small-scale validation`: 10 topics、全部 baseline、少量人工检查。
- `full run`: 完整 topics、正式 human evaluation、全部 ablation。

### 11.5 可能偏离

如果正式 human evaluation 成本过高：

- 不能直接换成自动 evaluator 并声称等价。
- 应记录 deviation。
- 若影响主 claim，回到 `Experiment Design Mode` 重新确认。

## 12. 交接到 Result Analysis Mode

`Result Analysis Mode` 接收的是 `Execution Package`，不是单张结果表。

交接内容必须包括：

- frozen `Experiment Blueprint` 的引用。
- 所有 run manifests。
- raw outputs 和 summary tables。
- configs、seeds、environment 和模型/API 版本。
- 失败记录。
- 偏离记录。
- fresh verification evidence。
- known limitations。

如果交接包缺少关键证据，结果分析只能做 provisional inspection，不能冻结 `Result Analysis Report`。

## 13. 参考原则

本模式吸收以下通用工程纪律，但不绑定特定平台：

- 隔离工作区优先。
- 行为代码默认 TDD。
- 垂直切片和 tracer bullet。
- Spec compliance review 先于 code quality review。
- 接受 review 前先验证其技术正确性。
- 完成前必须 fresh verification。
- 失败、偏离和负结果必须记录，不能只保留成功路径。
