import type {SearchBudgetState, SearchResponse} from "@academic-agent/schemas";

export const DEFAULT_SEARCH_BUDGET_MAX_CALLS = 12;
export const DEFAULT_MIN_CLOSEST_PAPERS = 8;

export function createSearchBudgetState(runId: string): SearchBudgetState {
  return {
    run_id: runId,
    paper_search_calls: 0,
    unique_paper_count: 0,
    budget_exhausted: false,
  };
}

export function paperKey(result: {title?: string; url?: string}): string {
  const title = String(result.title ?? "").trim().toLowerCase();
  const url = String(result.url ?? "").trim().toLowerCase();
  return url || title;
}

export function updateSearchBudgetFromResponse(
  state: SearchBudgetState,
  response: SearchResponse,
  seenKeys: Set<string>,
  maxCalls = DEFAULT_SEARCH_BUDGET_MAX_CALLS,
): SearchBudgetState {
  const nextCalls = state.paper_search_calls + 1;
  for (const result of response.results) {
    seenKeys.add(paperKey(result));
  }
  const uniqueCount = seenKeys.size;
  const exhausted = nextCalls >= maxCalls;
  return {
    ...state,
    paper_search_calls: nextCalls,
    unique_paper_count: uniqueCount,
    budget_exhausted: exhausted,
  };
}

export function canPaperSearch(state: SearchBudgetState, maxCalls = DEFAULT_SEARCH_BUDGET_MAX_CALLS): boolean {
  return !state.budget_exhausted && state.paper_search_calls < maxCalls;
}
