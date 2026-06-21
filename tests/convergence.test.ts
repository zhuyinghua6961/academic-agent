import {describe, expect, it} from "vitest";

import {buildPlanConvergenceStatus} from "@academic-agent/agent-core";
import {defaultPlanBody} from "@academic-agent/harness";

describe("plan convergence", () => {
  it("starts with all gates closed", () => {
    const status = buildPlanConvergenceStatus({
      threadId: "thread_test",
      currentMode: "idea_plan",
      lifecycleState: "lightweight_diagnosis",
      ideaVersion: 1,
      body: defaultPlanBody(),
      uniquePaperCount: 0,
      miniReviewCount: 0,
      hookCount: 0,
      humanReadCount: 0,
      hasIntake: false,
      diagnosisStable: true,
      latestReviewDecision: null,
      latestReviewScores: null,
      latestReviewConfidence: null,
      hasMetaReviewCanFreeze: false,
      openFatalDisagreements: 0,
      openMajorDisagreementsUnresolved: 0,
      planFrozen: false,
      candidateReviewRecorded: false,
      noveltyPathVerified: false,
    });
    expect(status.can_freeze).toBe(false);
    expect(status.can_enter_experiment_design).toBe(false);
    expect(status.checks.some((check) => check.id === "L3" && !check.satisfied)).toBe(true);
    expect(status.checks.some((check) => check.id === "A6" && !check.satisfied)).toBe(true);
    expect(status.checks.some((check) => check.id === "A7" && !check.satisfied)).toBe(true);
  });

  it("uses falsification when CandidateReviewer scores are absent", () => {
    const body = defaultPlanBody();
    body.falsification_condition = "Ablate mechanism X and measure drop";
    const status = buildPlanConvergenceStatus({
      threadId: "thread_test",
      currentMode: "idea_plan",
      lifecycleState: "candidate_idea_review",
      ideaVersion: 1,
      body,
      uniquePaperCount: 3,
      miniReviewCount: 3,
      hookCount: 1,
      humanReadCount: 0,
      hasIntake: true,
      diagnosisStable: true,
      latestReviewDecision: null,
      latestReviewScores: null,
      latestReviewConfidence: null,
      hasMetaReviewCanFreeze: false,
      openFatalDisagreements: 0,
      openMajorDisagreementsUnresolved: 0,
      planFrozen: false,
      candidateReviewRecorded: false,
      noveltyPathVerified: true,
    });
    expect(status.checks.find((check) => check.id === "A6")?.satisfied).toBe(true);
    expect(status.checks.find((check) => check.id === "A7")?.satisfied).toBe(false);
  });
});
