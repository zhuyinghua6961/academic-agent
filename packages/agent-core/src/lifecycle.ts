import type {LifecycleState, PlanConvergenceStatus} from "@academic-agent/schemas";

const ORDER: LifecycleState[] = [
  "lightweight_diagnosis",
  "idea_understanding",
  "human_agent_reading",
  "innovation_hook_mining",
  "candidate_idea_review",
  "research_idea_plan_freeze",
];

export function resumeLifecycleState(
  current: LifecycleState,
  convergence: PlanConvergenceStatus,
): LifecycleState {
  if (current !== "paused") {
    return current;
  }
  if (!convergence.checks.find((c) => c.id === "L1")?.satisfied) {
    return "idea_understanding";
  }
  const miniReviews = convergence.checks.find((c) => c.id === "L4");
  if (miniReviews && !miniReviews.satisfied) {
    return "human_agent_reading";
  }
  const hooks = convergence.checks.find((c) => c.id === "L5");
  if (hooks && !hooks.satisfied) {
    return "innovation_hook_mining";
  }
  if (convergence.can_enter_candidate_review) {
    return "candidate_idea_review";
  }
  return "idea_understanding";
}

export function shouldPauseWorkflow(input: {
  convergence: PlanConvergenceStatus;
  searchBudgetExhausted: boolean;
  miniReviewCount: number;
  humanReadCount: number;
}): {paused: boolean; reason: string | null} {
  const l3 = input.convergence.checks.find((c) => c.id === "L3");
  if (input.searchBudgetExhausted && l3 && !l3.satisfied) {
    return {
      paused: true,
      reason: "文献检索预算已用尽，但 closest work 覆盖仍不足。请补充论文或调整检索策略。",
    };
  }
  const l1 = input.convergence.checks.find((c) => c.id === "L1");
  if (l1 && !l1.satisfied && input.convergence.lifecycle_state === "candidate_idea_review") {
    return {
      paused: true,
      reason: "Intake 未完成，无法进入 candidate review。请补充 compute/data/timeline 约束。",
    };
  }
  const l4 = input.convergence.checks.find((c) => c.id === "L4");
  if (
    l4 &&
    !l4.satisfied &&
    input.miniReviewCount < 2 &&
    input.humanReadCount < 2 &&
    input.convergence.lifecycle_state === "innovation_hook_mining"
  ) {
    return {
      paused: true,
      reason: "关键论文理解不足。请 /read 精读或使用 /papers add 补充本地 PDF。",
    };
  }
  return {paused: false, reason: null};
}

export function nextLifecycleState(
  current: LifecycleState,
  convergence: PlanConvergenceStatus,
  options: {
    miniReviewCount: number;
    hookCount: number;
    hasIntake: boolean;
    paused?: boolean;
  },
): LifecycleState {
  if (options.paused) {
    return "paused";
  }
  if (current === "paused") {
    return "idea_understanding";
  }
  if (current === "experiment_design" || current === "research_idea_plan_freeze") {
    return current;
  }
  if (!options.hasIntake && (current === "lightweight_diagnosis" || current === "idle")) {
    return "idea_understanding";
  }
  if (!options.hasIntake && convergence.can_enter_candidate_review) {
    return current === "candidate_idea_review" ? current : "idea_understanding";
  }
  if (options.miniReviewCount < 3 && current !== "human_agent_reading") {
    if (current === "idea_understanding" || current === "lightweight_diagnosis") {
      return "human_agent_reading";
    }
  }
  if (options.hookCount < 1 && options.miniReviewCount >= 3) {
    return "innovation_hook_mining";
  }
  if (convergence.can_enter_candidate_review && current !== "candidate_idea_review") {
    return "candidate_idea_review";
  }
  if (convergence.can_freeze) {
    return "research_idea_plan_freeze";
  }
  const index = ORDER.indexOf(current);
  if (index >= 0 && index < ORDER.length - 1 && options.hasIntake) {
    return ORDER[index + 1] ?? current;
  }
  return current === "idle" ? "lightweight_diagnosis" : current;
}

export function intakeComplete(body: {
  feasibility: {compute: string; data: string; timeline: string};
  compute_profile: string;
  data_profile: string;
}): boolean {
  return Boolean(
    body.feasibility.compute.trim() &&
      body.feasibility.data.trim() &&
      body.feasibility.timeline.trim() &&
      body.compute_profile.trim() &&
      body.data_profile.trim(),
  );
}
