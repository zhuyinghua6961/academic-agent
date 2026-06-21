import fs from "node:fs";
import path from "node:path";

import {
  DisagreementLogSchema,
  ExperimentBlueprintBodySchema,
  ExperimentBlueprintDraftSchema,
  ExperimentBlueprintSchema,
  ExperimentMetaReviewSchema,
  ExtendedResearchIdeaPlanDraftSchema,
  ExtendedResearchIdeaPlanSchema,
  IdeaMetaReviewSchema,
  InnovationHookSchema,
  PaperMiniReviewSchema,
  ResearchIdeaPlanBodySchema,
  utcNow,
  newId,
  type ArtifactMetadata,
  type Diagnosis,
  type DisagreementLog,
  type ExperimentBlueprint,
  type ExperimentBlueprintBody,
  type ExperimentBlueprintDraft,
  type ExperimentMetaReview,
  type ExtendedResearchIdeaPlan,
  type ExtendedResearchIdeaPlanDraft,
  type IdeaMetaReview,
  type InnovationHook,
  type PaperMiniReview,
  type ResearchIdeaPlanBody,
  type ContextPacket,
} from "@academic-agent/schemas";
import type {WorkspacePort} from "@academic-agent/workspace-port";

import type {ArtifactManager} from "./harness.js";

function writeSortedJson(filePath: string, payload: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

export function defaultPlanBody(): ResearchIdeaPlanBody {
  return ResearchIdeaPlanBodySchema.parse({});
}

export function readExtendedDraft(
  manager: ArtifactManager,
  artifactId: string,
): [ArtifactMetadata, ExtendedResearchIdeaPlanDraft] {
  const metadata = manager.workspace.get_artifact_metadata(artifactId);
  const payload: unknown = JSON.parse(fs.readFileSync(metadata.metadata_path, "utf8"));
  const record = payload as {draft?: unknown};
  const draft = ExtendedResearchIdeaPlanDraftSchema.parse(record.draft);
  return [metadata, draft];
}

export function writeExtendedResearchIdeaDraft(
  manager: ArtifactManager,
  runId: string,
  diagnosis: Diagnosis,
  context: ContextPacket,
  traceRefs: string[],
  body: ResearchIdeaPlanBody,
  artifactId: string | null = null,
): [ArtifactMetadata, ExtendedResearchIdeaPlanDraft] {
  manager.workspace.ensure_initialized();
  const nextArtifactId = artifactId ?? newId("artifact");
  const title = "ResearchIdeaPlanDraft";
  const markdownPath = path.join(manager.workspace.workspaceDir, "artifacts", `${nextArtifactId}.md`);
  const metadataPath = path.join(manager.workspace.workspaceDir, "artifacts", `${nextArtifactId}.json`);
  const createdAt = utcNow();
  const draft: ExtendedResearchIdeaPlanDraft = {
    artifact_id: nextArtifactId,
    title,
    source_run_id: runId,
    diagnosis,
    body,
    context_id: context.context_id,
    markdown_path: markdownPath,
    metadata_path: metadataPath,
    created_at: createdAt,
  };
  const metadata: ArtifactMetadata = {
    artifact_id: nextArtifactId,
    artifact_type: "ResearchIdeaPlanDraft",
    status: "draft",
    title,
    path: markdownPath,
    metadata_path: metadataPath,
    schema_version: "v1",
    source_run_id: runId,
    trace_refs: traceRefs,
    created_at: createdAt,
  };
  fs.writeFileSync(markdownPath, renderExtendedDraftMarkdown(draft), "utf8");
  writeSortedJson(metadataPath, {metadata, draft});
  manager.workspace.insert_artifact(metadata);
  return [metadata, draft];
}

export function freezeExtendedResearchIdeaPlan(
  manager: ArtifactManager,
  sourceMetadata: ArtifactMetadata,
  draft: ExtendedResearchIdeaPlanDraft,
  renderContext: {
    reviewDecision?: string | null;
    reviewScores?: import("@academic-agent/schemas").ReviewScores | null;
    reviewConfidence?: string | null;
    reviewNotes?: string | null;
    metaReviewSummary?: string | null;
    metaCanFreeze?: boolean;
  } = {},
): [ArtifactMetadata, ExtendedResearchIdeaPlan] {
  manager.workspace.ensure_initialized();
  const frozenAt = utcNow();
  const artifactId = newId("artifact");
  const markdownPath = path.join(manager.workspace.workspaceDir, "artifacts", `${artifactId}.md`);
  const metadataPath = path.join(manager.workspace.workspaceDir, "artifacts", `${artifactId}.json`);
  const plan: ExtendedResearchIdeaPlan = {
    plan_id: newId("plan"),
    artifact_id: artifactId,
    source_draft_artifact_id: sourceMetadata.artifact_id,
    source_run_id: draft.source_run_id,
    title: "ResearchIdeaPlan",
    diagnosis: draft.diagnosis,
    body: draft.body,
    context_id: draft.context_id,
    markdown_path: markdownPath,
    metadata_path: metadataPath,
    status: "frozen",
    frozen_at: frozenAt,
    created_at: frozenAt,
  };
  const metadata: ArtifactMetadata = {
    artifact_id: artifactId,
    artifact_type: "ResearchIdeaPlan",
    status: "frozen",
    title: plan.title,
    path: markdownPath,
    metadata_path: metadataPath,
    schema_version: "v1",
    source_run_id: draft.source_run_id,
    trace_refs: sourceMetadata.trace_refs ?? [],
    created_at: frozenAt,
  };
  fs.writeFileSync(markdownPath, renderFrozenPlanMarkdown(plan, renderContext), "utf8");
  writeSortedJson(metadataPath, {metadata, plan});
  manager.workspace.insert_artifact(metadata);
  return [metadata, plan];
}

export function readExtendedPlan(
  manager: ArtifactManager,
  artifactId: string,
): [ArtifactMetadata, ExtendedResearchIdeaPlan] {
  const metadata = manager.workspace.get_artifact_metadata(artifactId);
  const payload: unknown = JSON.parse(fs.readFileSync(metadata.metadata_path, "utf8"));
  const record = payload as {plan?: unknown};
  return [metadata, ExtendedResearchIdeaPlanSchema.parse(record.plan)];
}

export function writePaperMiniReview(
  manager: ArtifactManager,
  runId: string,
  review: Omit<PaperMiniReview, "artifact_id" | "review_id" | "markdown_path" | "metadata_path" | "created_at">,
  traceRefs: string[] = [],
): [ArtifactMetadata, PaperMiniReview] {
  const artifactId = newId("artifact");
  const markdownPath = path.join(manager.workspace.workspaceDir, "artifacts", `${artifactId}.md`);
  const metadataPath = path.join(manager.workspace.workspaceDir, "artifacts", `${artifactId}.json`);
  const createdAt = utcNow();
  const record: PaperMiniReview = {
    ...review,
    review_id: newId("mini_review"),
    artifact_id: artifactId,
    markdown_path: markdownPath,
    metadata_path: metadataPath,
    created_at: createdAt,
  };
  const metadata: ArtifactMetadata = {
    artifact_id: artifactId,
    artifact_type: "PaperMiniReview",
    status: "frozen",
    title: `PaperMiniReview: ${record.title}`,
    path: markdownPath,
    metadata_path: metadataPath,
    schema_version: "v1",
    source_run_id: runId,
    trace_refs: traceRefs,
    created_at: createdAt,
  };
  fs.writeFileSync(markdownPath, renderMiniReviewMarkdown(record), "utf8");
  writeSortedJson(metadataPath, {metadata, mini_review: record});
  manager.workspace.insert_artifact(metadata);
  return [metadata, PaperMiniReviewSchema.parse(record)];
}

export function writeClosestWorkMatrix(
  manager: ArtifactManager,
  runId: string,
  threadId: string,
  entries: import("@academic-agent/schemas").ClosestWorkEntry[],
  traceRefs: string[] = [],
): [ArtifactMetadata, import("@academic-agent/schemas").ClosestWorkMatrix] {
  const artifactId = newId("artifact");
  const markdownPath = path.join(manager.workspace.workspaceDir, "artifacts", `${artifactId}.md`);
  const metadataPath = path.join(manager.workspace.workspaceDir, "artifacts", `${artifactId}.json`);
  const createdAt = utcNow();
  const record = {
    matrix_id: newId("matrix"),
    artifact_id: artifactId,
    source_run_id: runId,
    thread_id: threadId,
    entries,
    markdown_path: markdownPath,
    metadata_path: metadataPath,
    created_at: createdAt,
  };
  const metadata: ArtifactMetadata = {
    artifact_id: artifactId,
    artifact_type: "ClosestWorkMatrix",
    status: "frozen",
    title: `ClosestWorkMatrix: ${threadId.slice(-8)}`,
    path: markdownPath,
    metadata_path: metadataPath,
    schema_version: "v1",
    source_run_id: runId,
    trace_refs: traceRefs,
    created_at: createdAt,
  };
  const table = entries
    .map(
      (row) =>
        `| ${row.title} | ${row.status} | ${row.mechanism} | ${row.claim} | ${row.gap_for_us} | ${row.novelty_risk} |`,
    )
    .join("\n");
  fs.writeFileSync(
    markdownPath,
    [
      "# Closest Work Matrix",
      "",
      "| Paper | Status | Mechanism | Claim | Gap for Us | Novelty Risk |",
      "| --- | --- | --- | --- | --- | --- |",
      table || "| | | | | | |",
      "",
    ].join("\n"),
    "utf8",
  );
  writeSortedJson(metadataPath, {metadata, matrix: record});
  manager.workspace.insert_artifact(metadata);
  return [metadata, record as import("@academic-agent/schemas").ClosestWorkMatrix];
}

export function writeInnovationHook(
  manager: ArtifactManager,
  runId: string,
  hook: Omit<InnovationHook, "artifact_id" | "hook_id" | "markdown_path" | "metadata_path" | "created_at">,
  traceRefs: string[] = [],
): [ArtifactMetadata, InnovationHook] {
  const artifactId = newId("artifact");
  const markdownPath = path.join(manager.workspace.workspaceDir, "artifacts", `${artifactId}.md`);
  const metadataPath = path.join(manager.workspace.workspaceDir, "artifacts", `${artifactId}.json`);
  const createdAt = utcNow();
  const record: InnovationHook = {
    ...hook,
    hook_id: newId("hook"),
    artifact_id: artifactId,
    markdown_path: markdownPath,
    metadata_path: metadataPath,
    created_at: createdAt,
  };
  const metadata: ArtifactMetadata = {
    artifact_id: artifactId,
    artifact_type: "InnovationHook",
    status: "frozen",
    title: `InnovationHook: ${record.trigger_paper}`,
    path: markdownPath,
    metadata_path: metadataPath,
    schema_version: "v1",
    source_run_id: runId,
    trace_refs: traceRefs,
    created_at: createdAt,
  };
  fs.writeFileSync(markdownPath, renderHookMarkdown(record), "utf8");
  writeSortedJson(metadataPath, {metadata, hook: record});
  manager.workspace.insert_artifact(metadata);
  return [metadata, InnovationHookSchema.parse(record)];
}

export function writeDisagreementLog(
  manager: ArtifactManager,
  runId: string,
  log: Omit<DisagreementLog, "artifact_id" | "log_id" | "markdown_path" | "metadata_path" | "created_at">,
  traceRefs: string[] = [],
): [ArtifactMetadata, DisagreementLog] {
  const artifactId = newId("artifact");
  const markdownPath = path.join(manager.workspace.workspaceDir, "artifacts", `${artifactId}.md`);
  const metadataPath = path.join(manager.workspace.workspaceDir, "artifacts", `${artifactId}.json`);
  const createdAt = utcNow();
  const record: DisagreementLog = {
    ...log,
    log_id: newId("disagreement"),
    artifact_id: artifactId,
    markdown_path: markdownPath,
    metadata_path: metadataPath,
    created_at: createdAt,
  };
  const metadata: ArtifactMetadata = {
    artifact_id: artifactId,
    artifact_type: "DisagreementLog",
    status: "frozen",
    title: `Disagreement: ${record.topic}`,
    path: markdownPath,
    metadata_path: metadataPath,
    schema_version: "v1",
    source_run_id: runId,
    trace_refs: traceRefs,
    created_at: createdAt,
  };
  fs.writeFileSync(markdownPath, renderDisagreementMarkdown(record), "utf8");
  writeSortedJson(metadataPath, {metadata, log: record});
  manager.workspace.insert_artifact(metadata);
  return [metadata, DisagreementLogSchema.parse(record)];
}

export function writeIdeaMetaReview(
  manager: ArtifactManager,
  runId: string,
  meta: Omit<IdeaMetaReview, "artifact_id" | "meta_review_id" | "markdown_path" | "metadata_path" | "created_at">,
  traceRefs: string[] = [],
): [ArtifactMetadata, IdeaMetaReview] {
  const artifactId = newId("artifact");
  const markdownPath = path.join(manager.workspace.workspaceDir, "artifacts", `${artifactId}.md`);
  const metadataPath = path.join(manager.workspace.workspaceDir, "artifacts", `${artifactId}.json`);
  const createdAt = utcNow();
  const record: IdeaMetaReview = {
    ...meta,
    meta_review_id: newId("meta_review"),
    artifact_id: artifactId,
    markdown_path: markdownPath,
    metadata_path: metadataPath,
    created_at: createdAt,
  };
  const metadata: ArtifactMetadata = {
    artifact_id: artifactId,
    artifact_type: "IdeaMetaReview",
    status: "frozen",
    title: "AC Meta-review",
    path: markdownPath,
    metadata_path: metadataPath,
    schema_version: "v1",
    source_run_id: runId,
    trace_refs: traceRefs,
    created_at: createdAt,
  };
  fs.writeFileSync(markdownPath, renderIdeaMetaReviewMarkdown(record), "utf8");
  writeSortedJson(metadataPath, {metadata, meta_review: record});
  manager.workspace.insert_artifact(metadata);
  return [metadata, IdeaMetaReviewSchema.parse(record)];
}

export function writeExperimentBlueprintDraft(
  manager: ArtifactManager,
  runId: string,
  linkedPlanArtifactId: string,
  body: ExperimentBlueprintBody,
  artifactId: string | null = null,
): [ArtifactMetadata, ExperimentBlueprintDraft] {
  const nextArtifactId = artifactId ?? newId("artifact");
  const markdownPath = path.join(manager.workspace.workspaceDir, "artifacts", `${nextArtifactId}.md`);
  const metadataPath = path.join(manager.workspace.workspaceDir, "artifacts", `${nextArtifactId}.json`);
  const createdAt = utcNow();
  const draft: ExperimentBlueprintDraft = {
    artifact_id: nextArtifactId,
    title: "ExperimentBlueprintDraft",
    source_run_id: runId,
    linked_plan_artifact_id: linkedPlanArtifactId,
    body: ExperimentBlueprintBodySchema.parse(body),
    markdown_path: markdownPath,
    metadata_path: metadataPath,
    created_at: createdAt,
  };
  const metadata: ArtifactMetadata = {
    artifact_id: nextArtifactId,
    artifact_type: "ExperimentBlueprintDraft",
    status: "draft",
    title: draft.title,
    path: markdownPath,
    metadata_path: metadataPath,
    schema_version: "v1",
    source_run_id: runId,
    trace_refs: [],
    created_at: createdAt,
  };
  fs.writeFileSync(markdownPath, renderBlueprintMarkdown(draft), "utf8");
  writeSortedJson(metadataPath, {metadata, draft});
  manager.workspace.insert_artifact(metadata);
  return [metadata, ExperimentBlueprintDraftSchema.parse(draft)];
}

export function freezeExperimentBlueprint(
  manager: ArtifactManager,
  sourceMetadata: ArtifactMetadata,
  draft: ExperimentBlueprintDraft,
): [ArtifactMetadata, ExperimentBlueprint] {
  const frozenAt = utcNow();
  const artifactId = newId("artifact");
  const markdownPath = path.join(manager.workspace.workspaceDir, "artifacts", `${artifactId}.md`);
  const metadataPath = path.join(manager.workspace.workspaceDir, "artifacts", `${artifactId}.json`);
  const blueprint: ExperimentBlueprint = {
    blueprint_id: newId("blueprint"),
    artifact_id: artifactId,
    source_draft_artifact_id: sourceMetadata.artifact_id,
    source_run_id: draft.source_run_id,
    title: "ExperimentBlueprint",
    linked_plan_artifact_id: draft.linked_plan_artifact_id,
    body: draft.body,
    markdown_path: markdownPath,
    metadata_path: metadataPath,
    status: "frozen",
    frozen_at: frozenAt,
    created_at: frozenAt,
  };
  const metadata: ArtifactMetadata = {
    artifact_id: artifactId,
    artifact_type: "ExperimentBlueprint",
    status: "frozen",
    title: blueprint.title,
    path: markdownPath,
    metadata_path: metadataPath,
    schema_version: "v1",
    source_run_id: draft.source_run_id,
    trace_refs: sourceMetadata.trace_refs ?? [],
    created_at: frozenAt,
  };
  fs.writeFileSync(markdownPath, renderFrozenBlueprintMarkdown(blueprint), "utf8");
  writeSortedJson(metadataPath, {metadata, blueprint});
  manager.workspace.insert_artifact(metadata);
  return [metadata, ExperimentBlueprintSchema.parse(blueprint)];
}

export function writeExperimentMetaReview(
  manager: ArtifactManager,
  runId: string,
  meta: Omit<ExperimentMetaReview, "artifact_id" | "meta_review_id" | "markdown_path" | "metadata_path" | "created_at">,
  traceRefs: string[] = [],
): [ArtifactMetadata, ExperimentMetaReview] {
  const artifactId = newId("artifact");
  const markdownPath = path.join(manager.workspace.workspaceDir, "artifacts", `${artifactId}.md`);
  const metadataPath = path.join(manager.workspace.workspaceDir, "artifacts", `${artifactId}.json`);
  const createdAt = utcNow();
  const record: ExperimentMetaReview = {
    ...meta,
    meta_review_id: newId("exp_meta_review"),
    artifact_id: artifactId,
    markdown_path: markdownPath,
    metadata_path: metadataPath,
    created_at: createdAt,
  };
  const metadata: ArtifactMetadata = {
    artifact_id: artifactId,
    artifact_type: "ExperimentMetaReview",
    status: "frozen",
    title: "Experiment AC Meta-review",
    path: markdownPath,
    metadata_path: metadataPath,
    schema_version: "v1",
    source_run_id: runId,
    trace_refs: traceRefs,
    created_at: createdAt,
  };
  fs.writeFileSync(markdownPath, renderExperimentMetaReviewMarkdown(record), "utf8");
  writeSortedJson(metadataPath, {metadata, meta_review: record});
  manager.workspace.insert_artifact(metadata);
  return [metadata, ExperimentMetaReviewSchema.parse(record)];
}

function renderExtendedDraftMarkdown(draft: ExtendedResearchIdeaPlanDraft): string {
  return renderFrozenPlanMarkdown({
    plan_id: "draft",
    artifact_id: draft.artifact_id,
    source_draft_artifact_id: draft.artifact_id,
    source_run_id: draft.source_run_id,
    title: draft.title,
    diagnosis: draft.diagnosis,
    body: draft.body,
    context_id: draft.context_id,
    markdown_path: draft.markdown_path,
    metadata_path: draft.metadata_path,
    status: "frozen",
    frozen_at: draft.created_at,
    created_at: draft.created_at,
  }).replace("# ResearchIdeaPlan", "# ResearchIdeaPlanDraft").replace("`- Status: `frozen`", "- Status: `draft`");
}

export function renderFrozenPlanMarkdown(
  plan: ExtendedResearchIdeaPlan,
  ctx: {
    reviewDecision?: string | null;
    reviewScores?: import("@academic-agent/schemas").ReviewScores | null;
    reviewConfidence?: string | null;
    reviewNotes?: string | null;
    metaReviewSummary?: string | null;
    metaCanFreeze?: boolean;
  } = {},
): string {
  const body = plan.body;
  const diagnosis = plan.diagnosis;
  const closest = body.closest_related_work
    .map(
      (row) =>
        `| ${row.title} | ${row.status} | ${row.mechanism} | ${row.claim} | ${row.gap_for_us} | ${row.novelty_risk} |`,
    )
    .join("\n");
  return [
    `# ResearchIdeaPlan: ${plan.title}`,
    "",
    "## Version",
    "",
    `- Version: thread idea_version (see metadata)`,
    `- Status: \`${plan.status}\``,
    `- Frozen at: \`${plan.frozen_at}\``,
    "",
    "## Core Idea",
    "",
    `- Main Claim: ${body.main_claim}`,
    `- Problem: ${diagnosis.problem}`,
    `- Gap: ${diagnosis.gap}`,
    `- Candidate Mechanism: ${diagnosis.candidate_mechanism}`,
    `- Why Non-trivial: ${body.why_non_trivial}`,
    `- Why This Is Not Engineering Stitching: ${body.why_not_engineering_stitching}`,
    "",
    "## Evidence",
    "",
    "### Closest Related Work",
    "| Paper | Status | Mechanism | Claim | Gap for Us | Novelty Risk |",
    "| --- | --- | --- | --- | --- | --- |",
    closest || "| | | | | | |",
    "",
    "- Key Paper Mini-reviews: see PaperMiniReview artifacts",
    "- Innovation Hooks Used: see InnovationHook artifacts",
    "- Disagreement Logs: see DisagreementLog artifacts",
    "",
    "## Method Direction",
    "",
    `- Mechanism Sketch: ${body.mechanism_sketch}`,
    `- Expected Failure Mode: ${diagnosis.main_uncertainty}`,
    `- Falsification Condition: ${body.falsification_condition}`,
    `- Evidence Still Needed: ${diagnosis.evidence_needed.join("; ") || "none"}`,
    "",
    "## Feasibility",
    "",
    `- Compute: ${body.feasibility.compute}`,
    `- Data: ${body.feasibility.data}`,
    `- Annotation / Human Evaluation: ${body.feasibility.annotation}`,
    `- Timeline: ${body.feasibility.timeline}`,
    `- Low-compute Validation: ${body.feasibility.low_compute_validation}`,
    `- Ideal Extended Validation: ${body.feasibility.ideal_extended_validation}`,
    `- Compute Profile: ${body.compute_profile}`,
    `- Data Profile: ${body.data_profile}`,
    `- Target Standard: ${body.target_standard}`,
    "",
    "## Review",
    "",
    `- Decision: ${ctx.reviewDecision ?? "see IdeaReview artifact"}`,
    `- Confidence: ${ctx.reviewConfidence ?? "unknown"}`,
    ctx.reviewScores
      ? `- Scores: originality=${ctx.reviewScores.originality}, significance=${ctx.reviewScores.significance}, soundness=${ctx.reviewScores.soundness}, clarity=${ctx.reviewScores.clarity}, feasibility=${ctx.reviewScores.feasibility_resource_fit}`
      : "- Scores: see latest IdeaReview artifact",
    ctx.reviewNotes ? `- Notes: ${ctx.reviewNotes}` : "",
    "- Most Likely Rejection Reasons: _see CandidateReviewer artifact_",
    "- Required Revisions: _see latest review notes_",
    "",
    "## Ethics and Reproducibility",
    "",
    `- Data License / Privacy: ${body.ethics || "_TBD_"}`,
    `- Safety / Misuse Risk: _TBD_`,
    `- Reproducibility Path: ${body.reproducibility || "_TBD_"}`,
    `- Public Benchmark Alternative: _TBD_`,
    "",
    "## Freeze Decision",
    "",
    `- AC-style Decision: ${ctx.metaCanFreeze ? "can freeze" : "see IdeaMetaReview artifact"}`,
    `- AC Summary: ${ctx.metaReviewSummary ?? "see IdeaMetaReview artifact"}`,
    "- Conditions Met: see PlanConvergence checks",
    "- Remaining Risks: see IdeaMetaReview.remaining_risks",
    "- Next Mode: Experiment Design after frozen handoff",
    "",
    "## Assumptions",
    "",
    `- User confirmed: ${body.assumptions.user_confirmed.join("; ") || "none"}`,
    `- Agent inferred: ${body.assumptions.agent_inferred.join("; ") || "none"}`,
    `- To verify: ${body.assumptions.to_verify.join("; ") || "none"}`,
    "",
  ].join("\n");
}

function renderMiniReviewMarkdown(review: PaperMiniReview): string {
  return [
    `# Paper Mini-review: ${review.title}`,
    "",
    `- Status: ${review.status}`,
    `- Confidence: ${review.confidence}`,
    "",
    "## Summary",
    review.summary,
    "",
    "## Strengths",
    ...review.strengths.map((s) => `- ${s}`),
    "",
    "## Weaknesses",
    ...review.weaknesses.map((s) => `- ${s}`),
    "",
    "## Novelty Risk for Our Idea",
    review.novelty_risk_for_idea,
    "",
  ].join("\n");
}

function renderHookMarkdown(hook: InnovationHook): string {
  return [
    "# Innovation Hook",
    "",
    `- Trigger Paper: ${hook.trigger_paper}`,
    `- Unsolved Problem: ${hook.unsolved_problem}`,
    `- Candidate Mechanism: ${hook.candidate_mechanism}`,
    `- Why Non-trivial: ${hook.why_non_trivial}`,
    `- Validation Path: ${hook.validation_path}`,
    `- Novelty Risk: ${hook.novelty_risk}`,
    "",
  ].join("\n");
}

function renderDisagreementMarkdown(log: DisagreementLog): string {
  return [
    `# Disagreement: ${log.topic}`,
    "",
    `- User: ${log.user_position}`,
    `- Agent: ${log.agent_position}`,
    `- Resolution: ${log.current_resolution}`,
    `- Verification Task: ${log.verification_task}`,
    `- Impact: ${log.impact_on_idea_version}`,
    "",
  ].join("\n");
}

function renderIdeaMetaReviewMarkdown(meta: IdeaMetaReview): string {
  return [
    "# AC-style Meta-review",
    "",
    `- Candidate: ${meta.candidate}`,
    `- Decision: ${meta.decision}`,
    `- Can Freeze: ${meta.can_freeze}`,
    "",
    "## Evidence Summary",
    meta.evidence_summary,
    "",
    "## Remaining Risks",
    ...meta.remaining_risks.map((r) => `- ${r}`),
    "",
  ].join("\n");
}

function renderBlueprintMarkdown(draft: ExperimentBlueprintDraft): string {
  return renderFrozenBlueprintMarkdown({
    blueprint_id: "draft",
    artifact_id: draft.artifact_id,
    source_draft_artifact_id: draft.artifact_id,
    source_run_id: draft.source_run_id,
    title: draft.title,
    linked_plan_artifact_id: draft.linked_plan_artifact_id,
    body: draft.body,
    markdown_path: draft.markdown_path,
    metadata_path: draft.metadata_path,
    status: "frozen",
    frozen_at: draft.created_at,
    created_at: draft.created_at,
  }).replace("# ExperimentBlueprint", "# ExperimentBlueprintDraft");
}

function renderFrozenBlueprintMarkdown(blueprint: ExperimentBlueprint): string {
  const claims = blueprint.body.claim_evidence_map
    .map((c) => `- **${c.claim}**: ${c.required_experiment}`)
    .join("\n");
  const experiments = blueprint.body.experiment_set
    .map((e) => `- [${e.tier}] ${e.name}: ${e.purpose}`)
    .join("\n");
  return [
    "# ExperimentBlueprint",
    "",
    `- Main Claim: ${blueprint.body.main_claim}`,
    "",
    "## Claim-Evidence Map",
    claims || "- None",
    "",
    "## Experiment Set",
    experiments || "- None",
    "",
    "## Reproducibility",
    blueprint.body.reproducibility,
    "",
  ].join("\n");
}

function renderExperimentMetaReviewMarkdown(meta: ExperimentMetaReview): string {
  return [
    "# Experiment AC Meta-review",
    "",
    `- Can Move to Execution: ${meta.can_move_to_execution}`,
    "",
    "## Baseline Risks",
    ...meta.baseline_risks.map((r) => `- ${r}`),
    "",
    "## Metric Risks",
    ...meta.metric_risks.map((r) => `- ${r}`),
    "",
  ].join("\n");
}

export function latestBlueprintArtifact(workspace: WorkspacePort, threadId: string): ArtifactMetadata | null {
  for (const type of ["ExperimentBlueprint", "ExperimentBlueprintDraft"]) {
    const artifact = workspace.latest_artifact_for_thread(threadId, type);
    if (artifact) return artifact;
  }
  return null;
}
