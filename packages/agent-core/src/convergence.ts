import fs from "node:fs";

import {ArtifactManager, readExtendedDraft, readExtendedPlan, countHumanReadPapers} from "@academic-agent/harness";
import type {
  PlanConvergenceStatus,
  ResearchIdeaPlanBody,
  ReviewScores,
  WorkflowMode,
} from "@academic-agent/schemas";
import type {WorkspacePort} from "@academic-agent/workspace-port";

import {intakeComplete} from "./lifecycle.js";
import {paperKey} from "./search-budget.js";

export type ConvergenceInput = {
  threadId: string;
  currentMode: WorkflowMode;
  lifecycleState: PlanConvergenceStatus["lifecycle_state"];
  ideaVersion: number;
  body: ResearchIdeaPlanBody;
  uniquePaperCount: number;
  miniReviewCount: number;
  hookCount: number;
  humanReadCount: number;
  hasIntake: boolean;
  diagnosisStable: boolean;
  latestReviewDecision: string | null;
  latestReviewScores: ReviewScores | null;
  latestReviewConfidence: string | null;
  hasMetaReviewCanFreeze: boolean;
  openFatalDisagreements: number;
  openMajorDisagreementsUnresolved: number;
  planFrozen: boolean;
  candidateReviewRecorded: boolean;
  noveltyPathVerified: boolean;
};

const DEFAULT_MIN_CLOSEST = 8;
const DEFAULT_MIN_SCORE = 4;

function check(id: string, layer: "L" | "A" | "F" | "E", label: string, satisfied: boolean, detail = "") {
  return {id, layer, label, satisfied, detail};
}

export function buildPlanConvergenceStatus(input: ConvergenceInput): PlanConvergenceStatus {
  const checks = [
    check("L1", "L", "Intake complete (compute/data/timeline/target)", input.hasIntake, ""),
    check(
      "L2",
      "L",
      "Diagnosis stable (no recent Major+ impact)",
      input.diagnosisStable,
      "",
    ),
    check(
      "L3",
      "L",
      `Literature coverage (>= ${DEFAULT_MIN_CLOSEST} closest papers)`,
      input.uniquePaperCount >= DEFAULT_MIN_CLOSEST,
      `${input.uniquePaperCount}/${DEFAULT_MIN_CLOSEST}`,
    ),
    check(
      "L4",
      "L",
      "Key paper mini-reviews (>= 5) or human reads",
      input.miniReviewCount >= 5 || input.humanReadCount >= 5,
      `${input.miniReviewCount} reviews, ${input.humanReadCount} human reads`,
    ),
    check("L5", "L", "Innovation hooks aggregated", input.hookCount >= 1, `${input.hookCount} hooks`),
    check(
      "L6",
      "L",
      "Main claim + falsification condition",
      Boolean(input.body.main_claim.trim() && input.body.falsification_condition.trim()),
      "",
    ),
    check(
      "L7",
      "L",
      "No open Fatal disagreements",
      input.openFatalDisagreements === 0,
      `${input.openFatalDisagreements} open`,
    ),
  ];

  const scores = input.latestReviewScores;
  const scoreOk =
    scores !== null &&
    scores.originality >= DEFAULT_MIN_SCORE &&
    scores.significance >= DEFAULT_MIN_SCORE &&
    scores.soundness >= DEFAULT_MIN_SCORE &&
    scores.clarity >= DEFAULT_MIN_SCORE &&
    scores.feasibility_resource_fit >= DEFAULT_MIN_SCORE;

  checks.push(
    check(
      "A1",
      "A",
      `Review scores all >= ${DEFAULT_MIN_SCORE}`,
      scoreOk,
      scores ? JSON.stringify(scores) : "no scores",
    ),
    check(
      "A2",
      "A",
      "Review confidence high or medium",
      input.latestReviewConfidence === "high" || input.latestReviewConfidence === "medium",
      input.latestReviewConfidence ?? "none",
    ),
    check(
      "A3",
      "A",
      "Engineering stitching check documented",
      Boolean(input.body.why_not_engineering_stitching.trim()),
      "",
    ),
    check(
      "A6",
      "A",
      "Novelty / verifiable path (CandidateReviewer or falsification)",
      input.noveltyPathVerified,
      input.noveltyPathVerified ? "verified" : "missing",
    ),
    check(
      "A7",
      "A",
      "CandidateReviewer recorded with scores",
      input.candidateReviewRecorded,
      input.candidateReviewRecorded ? "yes" : "no",
    ),
    check(
      "A4",
      "A",
      "Latest review is Advance (Provisional blocks advance)",
      input.latestReviewDecision === "Advance",
      input.latestReviewDecision ?? "none",
    ),
    check(
      "A5",
      "A",
      "Provisional review requires explicit user follow-up",
      input.latestReviewDecision !== "Provisional",
      input.latestReviewDecision === "Provisional" ? "needs user confirmation" : "ok",
    ),
  );

  checks.push(
    check(
      "F1",
      "F",
      "Advance decision recorded",
      input.latestReviewDecision === "Advance",
      "",
    ),
    check(
      "F2",
      "F",
      "AC meta-review can_freeze",
      input.hasMetaReviewCanFreeze,
      "",
    ),
    check(
      "F3",
      "F",
      "Major disagreements resolved",
      input.openMajorDisagreementsUnresolved === 0,
      `${input.openMajorDisagreementsUnresolved} open`,
    ),
    check(
      "F4",
      "F",
      "Plan body fields complete",
      Boolean(
        input.body.main_claim &&
          input.body.mechanism_sketch &&
          input.body.compute_profile &&
          input.body.data_profile &&
          input.body.target_standard,
      ),
      "",
    ),
    check(
      "F5",
      "F",
      "Closest work table populated",
      input.body.closest_related_work.length >= DEFAULT_MIN_CLOSEST,
      `${input.body.closest_related_work.length}/${DEFAULT_MIN_CLOSEST}`,
    ),
    check(
      "F6",
      "F",
      "Not Provisional with low confidence",
      !(
        input.latestReviewDecision === "Provisional" ||
        input.latestReviewConfidence === "low"
      ),
      `${input.latestReviewDecision ?? "none"} / ${input.latestReviewConfidence ?? "none"}`,
    ),
  );

  checks.push(
    check("E1", "E", "ResearchIdeaPlan frozen", input.planFrozen, ""),
    check(
      "E2",
      "E",
      "Handoff fields present",
      Boolean(
        input.planFrozen &&
          input.body.main_claim.trim() &&
          input.body.mechanism_sketch.trim() &&
          input.body.closest_related_work.length >= 3 &&
          input.body.compute_profile.trim() &&
          input.body.data_profile.trim() &&
          input.body.target_standard.trim(),
      ),
      "",
    ),
  );

  const lChecks = checks.filter((c) => c.layer === "L");
  const aChecks = checks.filter((c) => c.layer === "A");
  const fChecks = checks.filter((c) => c.layer === "F");
  const eChecks = checks.filter((c) => c.layer === "E");

  return {
    thread_id: input.threadId,
    lifecycle_state: input.lifecycleState,
    current_mode: input.currentMode,
    idea_version: input.ideaVersion,
    can_enter_candidate_review: lChecks.every((c) => c.satisfied),
    can_advance: [...lChecks, ...aChecks].every((c) => c.satisfied),
    can_freeze: [...lChecks, ...aChecks, ...fChecks].every((c) => c.satisfied),
    can_enter_experiment_design: eChecks.every((c) => c.satisfied),
    checks,
  };
}

function loadPlanBody(workspace: WorkspacePort, threadId: string): ResearchIdeaPlanBody {
  const manager = new ArtifactManager(workspace);
  const artifact = workspace.latest_plan_artifact_for_thread(threadId);
  if (!artifact) {
    return defaultBody();
  }
  try {
    if (artifact.artifact_type === "ResearchIdeaPlan") {
      const [, plan] = readExtendedPlan(manager, artifact.artifact_id);
      return plan.body;
    }
    const [, draft] = readExtendedDraft(manager, artifact.artifact_id);
    return draft.body;
  } catch {
    return defaultBody();
  }
}

function countUniquePapers(workspace: WorkspacePort, threadId: string): number {
  const manager = new ArtifactManager(workspace);
  const artifacts = workspace.latest_artifacts_for_thread(threadId, "PaperSearchEvidence", 50);
  const keys = new Set<string>();
  for (const meta of artifacts) {
    try {
      const [, record] = manager.read_paper_search_evidence(meta.artifact_id);
      for (const result of record.search_response.results) {
        keys.add(paperKey(result));
      }
    } catch {
      continue;
    }
  }
  const body = loadPlanBody(workspace, threadId);
  for (const row of body.closest_related_work) {
    keys.add(paperKey({title: row.title}));
  }
  return keys.size;
}

export function loadConvergenceForThread(
  workspace: WorkspacePort,
  threadId: string,
): PlanConvergenceStatus {
  const thread = workspace.get_thread(threadId);
  const body = loadPlanBody(workspace, threadId);
  let miniReviewCount = 0;
  let hookCount = 0;
  let planFrozen = false;

  try {
    miniReviewCount = workspace.count_thread_artifacts(threadId, "PaperMiniReview");
    hookCount = workspace.count_thread_artifacts(threadId, "InnovationHook");
    const planArtifact = workspace.latest_plan_artifact_for_thread(threadId);
    planFrozen = planArtifact?.artifact_type === "ResearchIdeaPlan";
  } catch {
    // thread may have no artifacts yet
  }

  const uniquePaperCount = countUniquePapers(workspace, threadId);
  const latestReview = workspace.latest_idea_review(threadId);
  let scores: ReviewScores | null = null;
  if (latestReview?.scores_json) {
    try {
      scores = JSON.parse(String(latestReview.scores_json)) as ReviewScores;
    } catch {
      scores = null;
    }
  }
  const candidateReviewRecorded = latestReview !== null && scores !== null;
  const noveltyPathVerified = candidateReviewRecorded
    ? (scores?.originality ?? 0) >= DEFAULT_MIN_SCORE
    : Boolean(body.falsification_condition.trim());

  const hasIntake = intakeComplete(body);
  const humanReadCount = countHumanReadPapers(workspace);

  return buildPlanConvergenceStatus({
    threadId,
    currentMode: thread.current_mode ?? "idea_plan",
    lifecycleState: thread.lifecycle_state ?? "lightweight_diagnosis",
    ideaVersion: thread.idea_version ?? 1,
    body,
    uniquePaperCount,
    miniReviewCount,
    hookCount,
    humanReadCount,
    hasIntake,
    diagnosisStable: (thread.impact_level ?? "None") !== "Major" && (thread.impact_level ?? "None") !== "Fatal",
    latestReviewDecision: latestReview ? String(latestReview.decision) : null,
    latestReviewScores: scores,
    latestReviewConfidence: latestReview?.confidence ? String(latestReview.confidence) : null,
    hasMetaReviewCanFreeze: (() => {
      const meta = workspace.latest_artifact_by_type(threadId, "IdeaMetaReview");
      if (!meta) return false;
      try {
        const payload: unknown = JSON.parse(fs.readFileSync(meta.metadata_path, "utf8"));
        const record = payload as {meta_review?: {can_freeze?: boolean}};
        return record.meta_review?.can_freeze === true;
      } catch {
        return false;
      }
    })(),
    openFatalDisagreements: workspace.count_open_disagreements(threadId, "Fatal"),
    openMajorDisagreementsUnresolved: workspace.count_open_disagreements(threadId, "Major"),
    planFrozen,
    candidateReviewRecorded,
    noveltyPathVerified,
  });
}

function defaultBody(): ResearchIdeaPlanBody {
  return {
    main_claim: "",
    mechanism_sketch: "",
    why_non_trivial: "",
    why_not_engineering_stitching: "",
    falsification_condition: "",
    closest_related_work: [],
    feasibility: {
      compute: "",
      data: "",
      annotation: "",
      timeline: "",
      low_compute_validation: "",
      ideal_extended_validation: "",
    },
    compute_profile: "",
    data_profile: "",
    target_standard: "AI/ML top-tier conference",
    ethics: "",
    reproducibility: "",
    assumptions: {user_confirmed: [], agent_inferred: [], to_verify: []},
  };
}
