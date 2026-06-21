export type PlanIntent = "lightweight_diagnosis" | "full_idea_plan";

export function detectPlanIntent(idea: string, isContinuation: boolean): PlanIntent {
  if (isContinuation) {
    return "full_idea_plan";
  }
  const trimmed = idea.trim();
  const wordCount = trimmed.split(/\s+/).length;
  const lightweightMarkers = ["快速", "大概", "是否可行", "quick", "feasible", "worth pursuing"];
  const lower = trimmed.toLowerCase();
  if (wordCount < 12 && lightweightMarkers.some((m) => lower.includes(m.toLowerCase()))) {
    return "lightweight_diagnosis";
  }
  return "full_idea_plan";
}
