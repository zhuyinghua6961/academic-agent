import {
  writeClosestWorkMatrix,
  writeInnovationHook,
  writePaperMiniReview,
  type ArtifactManager,
} from "@academic-agent/harness";
import {recordedProviderEnabled} from "@academic-agent/providers";
import type {
  ClosestWorkEntry,
  ResearchIdeaPlanBody,
  SearchResponse,
  SearchResult,
} from "@academic-agent/schemas";

import {emitActivity} from "./activity-events.js";
import {verifyPublicationStatusLive} from "./publication-verify.js";
import type {SubagentHarness} from "./subagent-harness.js";
import {createHandoffPacket} from "./subagent-harness.js";
import type {WorkspacePort} from "@academic-agent/workspace-port";

import {paperKey} from "./search-budget.js";

const AUTO_MINI_REVIEW_TOP_N = 3;
const AUTO_HOOK_TARGET = 3;

export function formatContributionChainSummary(parts: {
  problem?: string;
  method?: string;
  claim?: string;
  limitation?: string;
}): string {
  return [
    `Problem: ${parts.problem ?? "unknown"}`,
    `Method: ${parts.method ?? "unknown"}`,
    `Claim: ${parts.claim ?? "unknown"}`,
    `Limitation: ${parts.limitation ?? "unknown"}`,
  ].join("\n");
}

export async function enrichSearchResultsPublicationStatus(
  results: SearchResult[],
  topN = AUTO_MINI_REVIEW_TOP_N,
): Promise<SearchResult[]> {
  const enriched = [...results];
  for (let i = 0; i < Math.min(topN, enriched.length); i += 1) {
    const item = enriched[i];
    if (item.publication_status && item.publication_status !== "unknown") {
      continue;
    }
    const metadata = item.metadata ?? {};
    const verified = await verifyPublicationStatusLive({
      arxiv_id: item.external_id,
      doi: typeof metadata.doi === "string" ? metadata.doi : null,
      title: item.title,
      comments: typeof metadata.comment === "string" ? metadata.comment : null,
    });
    enriched[i] = {
      ...item,
      publication_status: verified.publication_status,
      venue: item.venue ?? verified.venue ?? null,
    };
  }
  return enriched;
}

function existingMiniReviewTitles(workspace: WorkspacePort, threadId: string): Set<string> {
  const titles = new Set<string>();
  for (const meta of workspace.latest_artifacts_for_thread(threadId, "PaperMiniReview", 50)) {
    titles.add(meta.title.replace(/^PaperMiniReview:\s*/i, "").toLowerCase());
  }
  return titles;
}

export async function syncClosestWorkMatrixArtifact(
  artifactManager: ArtifactManager,
  runId: string,
  threadId: string,
  rows: ClosestWorkEntry[],
): Promise<string | null> {
  if (rows.length === 0) {
    return null;
  }
  const [artifact] = writeClosestWorkMatrix(artifactManager, runId, threadId, rows);
  return artifact.artifact_id;
}

export async function autoMiniReviewsFromSearch(
  workspace: WorkspacePort,
  artifactManager: ArtifactManager,
  subagentHarness: SubagentHarness,
  input: {
    runId: string;
    threadId: string;
    mainClaim: string;
    results: SearchResult[];
  },
): Promise<number> {
  const reviewed = existingMiniReviewTitles(workspace, input.threadId);
  const candidates = input.results
    .filter((item) => !reviewed.has(String(item.title ?? "").toLowerCase()))
    .slice(0, AUTO_MINI_REVIEW_TOP_N);
  if (candidates.length === 0) {
    return 0;
  }

  const packets = candidates.map((paper) =>
    createHandoffPacket({
      threadId: input.threadId,
      runId: input.runId,
      role: "novelty_reviewer",
      task: `Produce mini-review with contribution chain for ${paper.title}`,
      payload: {
        paper: {
          title: paper.title,
          url: paper.url,
          snippet: paper.snippet,
          publication_status: paper.publication_status,
        },
        main_claim: input.mainClaim,
      },
      outputSchema: "PaperMiniReviewDraft",
    }),
  );

  const paperTitles = candidates.map((paper) => String(paper.title ?? "").trim()).filter(Boolean);

  emitActivity(
    workspace,
    input.runId,
    "activity.started",
    "reading",
    `准备精读 ${candidates.length} 篇：${paperTitles.join("; ")}`,
    {paper_titles: paperTitles, count: candidates.length},
  );

  workspace.add_event(input.runId, "agent.fanout.started", {
    phase: "auto_mini_review",
    roles: packets.map((packet) => packet.role),
    count: packets.length,
    paper_titles: paperTitles,
  });
  const reports = await subagentHarness.invokeParallel(packets);
  workspace.add_event(input.runId, "agent.fanout.completed", {
    phase: "auto_mini_review",
    count: reports.length,
  });

  let written = 0;
  for (let i = 0; i < reports.length; i += 1) {
    const report = reports[i];
    const paper = candidates[i];
    if (!paper) {
      continue;
    }
    if (report.status !== "completed") {
      emitActivity(
        workspace,
        input.runId,
        "activity.updated",
        "reading",
        `精读未完成：${String(paper.title ?? "unknown paper")}`,
        {paper_title: paper.title, status: report.status},
      );
      continue;
    }
    const output = report.output as Record<string, unknown>;
    const summary = formatContributionChainSummary({
      problem: String(output.problem ?? paper.snippet?.slice(0, 120) ?? ""),
      method: String(output.method ?? output.mechanism ?? ""),
      claim: String(output.claim ?? paper.title ?? ""),
      limitation: String(output.limitation ?? output.novelty_risk ?? ""),
    });
    writePaperMiniReview(artifactManager, input.runId, {
      source_run_id: input.runId,
      paper_id: paper.external_id,
      title: String(paper.title),
      status: paper.publication_status ?? "unknown",
      summary,
      strengths: Array.isArray(output.strengths) ? output.strengths.map(String) : [],
      weaknesses: Array.isArray(output.weaknesses) ? output.weaknesses.map(String) : [String(output.novelty_risk ?? "")],
      questions: [],
      confidence: "medium",
      innovation_hooks: Array.isArray(output.innovation_hooks) ? output.innovation_hooks.map(String) : [],
      novelty_risk_for_idea: String(output.novelty_risk_for_idea ?? output.novelty_risk ?? ""),
    });
    written += 1;
  }

  if (written > 0) {
    const readTitles = candidates
      .slice(0, written)
      .map((paper) => String(paper.title ?? "").trim())
      .filter(Boolean);
    emitActivity(
      workspace,
      input.runId,
      "activity.completed",
      "reading",
      `精读完成 ${written} 篇：${readTitles.join("; ")}`,
      {written, paper_titles: readTitles},
    );
  }
  return written;
}

export async function autoExtractInnovationHooks(
  workspace: WorkspacePort,
  artifactManager: ArtifactManager,
  subagentHarness: SubagentHarness,
  input: {
    runId: string;
    threadId: string;
    mainClaim: string;
    planBody: ResearchIdeaPlanBody;
  },
): Promise<number> {
  const existing = workspace.count_thread_artifacts(input.threadId, "InnovationHook");
  if (existing >= AUTO_HOOK_TARGET) {
    return 0;
  }

  const miniReviews = workspace.latest_artifacts_for_thread(input.threadId, "PaperMiniReview", 10);
  if (miniReviews.length === 0) {
    return 0;
  }

  const packet = createHandoffPacket({
    threadId: input.threadId,
    runId: input.runId,
    role: "novelty_reviewer",
    task: "Extract up to 3 innovation hook candidates from mini-reviews.",
    payload: {
      main_claim: input.mainClaim,
      closest_related_work: input.planBody.closest_related_work.slice(0, 5),
      mini_review_titles: miniReviews.map((meta) => meta.title),
    },
    outputSchema: "InnovationHookBatch",
  });
  const report = await subagentHarness.invoke(packet);
  if (report.status !== "completed") {
    return 0;
  }

  const hooks = (report.output as {hooks?: unknown[]}).hooks ?? [];
  let written = 0;
  for (const raw of hooks.slice(0, AUTO_HOOK_TARGET - existing)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    writeInnovationHook(artifactManager, input.runId, {
      source_run_id: input.runId,
      trigger_paper: String(item.trigger_paper ?? ""),
      unsolved_problem: String(item.unsolved_problem ?? ""),
      candidate_mechanism: String(item.candidate_mechanism ?? input.mainClaim),
      why_non_trivial: String(item.why_non_trivial ?? ""),
      validation_path: String(item.validation_path ?? ""),
      novelty_risk: String(item.novelty_risk ?? "medium"),
      human_feedback: "",
    });
    written += 1;
  }

  if (written > 0) {
    const summary = hooks
      .slice(0, 3)
      .map((hook) =>
        hook && typeof hook === "object"
          ? String((hook as Record<string, unknown>).candidate_mechanism ?? "")
          : "",
      )
      .filter(Boolean)
      .join("; ");
    if (summary) {
      input.planBody.assumptions.agent_inferred = [
        ...new Set([...input.planBody.assumptions.agent_inferred, summary]),
      ].slice(0, 12);
    }
  }
  return written;
}

export async function runAfterPaperSearchPipeline(
  workspace: WorkspacePort,
  artifactManager: ArtifactManager,
  subagentHarness: SubagentHarness,
  input: {
    runId: string;
    threadId: string;
    planBody: ResearchIdeaPlanBody;
    searchResponse: SearchResponse;
  },
): Promise<SearchResponse> {
  const enrichedResults = recordedProviderEnabled()
    ? input.searchResponse.results
    : await enrichSearchResultsPublicationStatus(input.searchResponse.results);
  const response = {...input.searchResponse, results: enrichedResults};

  await syncClosestWorkMatrixArtifact(
    artifactManager,
    input.runId,
    input.threadId,
    input.planBody.closest_related_work,
  );

  const miniWritten = await autoMiniReviewsFromSearch(workspace, artifactManager, subagentHarness, {
    runId: input.runId,
    threadId: input.threadId,
    mainClaim: input.planBody.main_claim,
    results: enrichedResults,
  });
  workspace.add_event(input.runId, "literature.auto_mini_review", {written: miniWritten});

  if (miniWritten > 0) {
    const hooksWritten = await autoExtractInnovationHooks(workspace, artifactManager, subagentHarness, {
      runId: input.runId,
      threadId: input.threadId,
      mainClaim: input.planBody.main_claim,
      planBody: input.planBody,
    });
    if (hooksWritten > 0) {
      emitActivity(
        workspace,
        input.runId,
        "activity.completed",
        "literature",
        `从精读结果提取 ${hooksWritten} 条创新 hook`,
        {written: hooksWritten},
      );
    }
  }

  return response;
}

export function paperTitlesNeedingReading(
  workspace: WorkspacePort,
  threadId: string,
  rows: ClosestWorkEntry[],
  limit = 3,
): ClosestWorkEntry[] {
  const reviewed = existingMiniReviewTitles(workspace, threadId);
  const humanRead = new Set(
    rows
      .filter((row) => row.paper_id)
      .map((row) => String(row.paper_id)),
  );
  return rows
    .filter((row) => {
      const titleKey = row.title.toLowerCase();
      return !reviewed.has(titleKey) && !(row.paper_id && humanRead.has(row.paper_id));
    })
    .slice(0, limit);
}

export function mergeSearchResultIntoClosestWork(
  planBody: ResearchIdeaPlanBody,
  item: SearchResult,
): void {
  const key = paperKey(item);
  if (!key) return;
  const exists = planBody.closest_related_work.some(
    (row) => row.title.toLowerCase() === String(item.title ?? "").toLowerCase(),
  );
  if (!exists) {
    planBody.closest_related_work.push({
      title: String(item.title ?? key),
      status: item.publication_status ?? "unknown",
      mechanism: String(item.snippet ?? "").slice(0, 200),
      claim: "",
      evidence: String(item.url ?? ""),
      gap_for_us: "",
      novelty_risk: "medium",
    });
  }
}
