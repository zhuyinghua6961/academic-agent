# Idea Plan Mode Acceptance Checklist

Maps [idea-plan-mode.md](./idea-plan-mode.md) §2–§12 to verification.  
Legend: `[x]` automated or implemented · `[~]` partial · `[ ]` not done

## §2 Trigger & Lifecycle

- [x] §2.1 Intent split (`detectPlanIntent` in `packages/agent-core/src/intent.ts`)
- [x] §2.2 Lifecycle auto-migration (`nextLifecycleState` in `finalizeNode`)
- [x] §2.3 Impact `None|Minor|Major|Fatal` + `idea_version` bump (`classifyImpact`)
- [x] §2.4 Pause on literature gap (`shouldPauseWorkflow`: search budget + L3/L1/L4)

## §3 Idea Diagnosis

- [x] §3.1 Five-field diagnosis per run (planner LLM → `finalizeNode`)
- [~] §3.2 Clarifying questions in diagnosis JSON (no dedicated UI for recommendations)
- [x] §3.3 Intake fields in plan body (`intakeComplete` + `update_plan_body`)

## §4 Literature

- [x] §4.1 Search budget 12 calls; venue/recency rank; `publication_status` on results
- [x] §4.2 Reading modes `quick|guided|exam` + PaperReader subagent (`/read`, `runPaperReaderSession`)
- [x] §4.3 Contribution-chain in mini-review (`formatContributionChainSummary` in auto pipeline)
- [x] §4.4 PaperMiniReview auto after search (`autoMiniReviewsFromSearch` in `literature-pipeline.ts`)
- [x] §4.5 Innovation hooks auto (`autoExtractInnovationHooks` + manual tools)
- [x] §4.6 Closest work table in plan body + `update_closest_work_matrix`

## §5 Review

- [x] §5.1 Three-layer pipeline (`runReviewPipeline`: mini-review → hooks → CandidateReviewer → novelty batch)
- [x] §5.2 Five-dimension scores + Provisional + confidence (`/review --scores --confidence`)
- [x] §5.3 Advance hard conditions (A6/A7 novelty path + CandidateReviewer scores in convergence)
- [x] §5.4 AC meta-review LLM (`runAcMetaReview`, not convergence copy)

## §6 Debate

- [x] §6.1 Disagreement trigger (keyword + LLM `detectUserDisagreementLLM`)
- [x] §6.2 ResearchMentor → evidence question (`runResearchMentor`)
- [x] §6.3 DisagreementLog persistence; Fatal blocks freeze (L7, convergence)

## §7 Top-tier Bar

- [x] §7.2 Engineering stitching (`why_not_engineering_stitching` + CandidateReviewer default)
- [x] §7.3 Main claim + falsification (L6 convergence)

## §8–§9 Memory

- [x] §8 User taste vs gates (debate + `recordIdeaVersionBranch` on Major impact)
- [x] §9.1 Project Memory Map rebuild on artifact/review/freeze
- [x] §9.2 Assumption trichotomy in plan body schema
- [x] §9.3 External search audit (`paper_search.evidence.created`, `literature.auto_mini_review`)

## §10 Templates

- [x] §10.4 Frozen `ResearchIdeaPlan` markdown with review/meta context (`freezeExtendedResearchIdeaPlan` renderContext)
- [~] All §10 fields fillable during draft (depends on agent tool use)

## §11–§12 E2E

- [x] Recorded idea-plan tool loop (`tests/idea-plan-recorded.test.ts`)
- [x] Reject path + ResearchMentor side effect (`tests/idea-plan-reject.test.ts`, `reviewThreadPlanWithSideEffects`)
- [x] Coarse idea refactor / Major impact (`tests/idea-plan-refactor.test.ts`)
- [x] Experiment design agent loop (`tests/experiment-design-recorded.test.ts`)

## Plan → Experiment Design

- [x] Frozen plan handoff validation (`validateHandoff`)
- [x] Experiment agent loop + `update_blueprint_body`
- [x] Parallel baseline/metric/AC reviewers
- [x] Blueprint TUI: `/blueprint`, `/review-blueprint`, `/freeze-blueprint`, `/meta-review-blueprint`, `/experiment` + `watchRunEvents`

## Anti-fake gates (CI)

- [x] No `mock` provider in production code
- [x] `fallbackDiagnosis` throws instead of silent artifact write
- [x] `triggerIdeaMetaReview` uses AC subagent LLM
- [x] `/freeze` returns 409 when convergence or meta-review gate fails

## Automated commands

```bash
pnpm -r typecheck
pnpm test
```

Recorded fixtures: `tests/recordings/idea-plan/`, `tests/recordings/idea-plan/reviewer/`, `tests/recordings/experiment-design/`

## Manual live smoke

1. Configure planner + reviewer + extractor API keys (`/config`)
2. `/new <idea>` → multi-turn plan with search
3. `/convergence` — inspect L/A/F/E layers
4. `/review Advance --scores originality=5 ... --confidence high`
5. `/meta-review` — LLM AC artifact
6. `/freeze` — full `ResearchIdeaPlan`
7. `/experiment` → `/blueprint` → `/meta-review-blueprint` → `/review-blueprint Freeze` → `/freeze-blueprint`
