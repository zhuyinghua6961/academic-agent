import type {JsonObject, ProviderResponse, ResearchIdeaPlanBody, SearchBudgetState, ToolCall} from "@academic-agent/schemas";

import type {HistoryContextPacket} from "./context.js";
import type {IdeaPlanRunner} from "./runner.js";

export type IdeaPlanState = {
  idea: string;
  run_id: string;
  thread_id: string;
  messages: Array<Record<string, unknown>>;
  iteration: number;
  tool_calls: ToolCall[];
  context?: Record<string, unknown>;
  provider_response?: Record<string, unknown>;
  trace_id?: string;
  artifact_id?: string;
  draft?: Record<string, unknown>;
  diagnosis?: Record<string, unknown>;
  history_context?: HistoryContextPacket;
  plan_body: ResearchIdeaPlanBody;
  search_budget: SearchBudgetState;
  seen_paper_keys: string[];
  human_read_papers: string[];
};

export async function runAgentLoop(
  runner: IdeaPlanRunner,
  state: IdeaPlanState,
): Promise<IdeaPlanState> {
  let current = state;
  while (true) {
    current = await runner.agentNode(current);
    if (current.iteration >= runner.maxIterations) {
      return runner.finalizeNode(current);
    }
    if (current.tool_calls.length > 0) {
      current = await runner.toolsNode(current);
      continue;
    }
    return runner.finalizeNode(current);
  }
}

export function toolDecisionMessage(toolCalls: ToolCall[]): string {
  const names = uniqueToolNames(toolCalls);
  if (names.length === 1 && names[0] === "paper_search") {
    return "我判断需要先检索近邻论文，再评估 novelty 风险。";
  }
  if (names.includes("paper_search")) {
    return `我判断需要调用 ${names.join(", ")}，先补外部证据再诊断。`;
  }
  if (names.includes("web_search")) {
    return "我判断论文检索还不够，需要补充网页检索信息。";
  }
  return `我判断需要调用工具：${names.join(", ")}。`;
}

export function uniqueToolNames(toolCalls: ToolCall[]): string[] {
  const names: string[] = [];
  for (const toolCall of toolCalls) {
    if (!names.includes(toolCall.name)) {
      names.push(toolCall.name);
    }
  }
  return names;
}

export function toolStartMessage(toolName: string, arguments_: Record<string, unknown>): string {
  const query = String(arguments_.query ?? "").trim();
  const maxResults = arguments_.max_results;
  const suffix = maxResults ? `（最多 ${String(maxResults)} 条）` : "";
  if (toolName === "paper_search") {
    return `检索近邻论文：${query}${suffix}`;
  }
  if (toolName === "web_search") {
    return `检索开放网页：${query}${suffix}`;
  }
  return `调用工具 ${toolName}。`;
}

export function toolResultSummary(
  toolName: string,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const rawResults = result.results;
  const results = Array.isArray(rawResults) ? rawResults : [];
  const titles: string[] = [];
  const sources: string[] = [];
  const urls: string[] = [];
  for (const item of results.slice(0, 3)) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const title = String(record.title ?? "").trim();
    const source = String(record.source ?? "").trim();
    const url = String(record.url ?? "").trim();
    if (title) {
      titles.push(title);
    }
    if (source && !sources.includes(source)) {
      sources.push(source);
    }
    if (url) {
      urls.push(url);
    }
  }
  return {
    query: String(result.query ?? ""),
    source: String(result.source ?? toolName),
    result_count: results.length,
    top_titles: titles,
    sources,
    top_urls: urls,
    error_message: result.error ? String(result.error) : null,
  };
}

export function toolObservationMessage(
  toolName: string,
  summary: Record<string, unknown>,
  isError: boolean,
): string {
  if (isError) {
    const errorMessage = summary.error_message ? String(summary.error_message) : "工具返回错误。";
    const source = String(summary.source ?? toolName);
    if (errorMessage === "工具返回错误。") {
      return `${toolName} 没有成功完成：${source} 返回错误，未取得可用结果。`;
    }
    return `${toolName} 没有成功完成：${errorMessage}`;
  }
  const count = Number(summary.result_count ?? 0);
  const titles = (Array.isArray(summary.top_titles) ? summary.top_titles : [])
    .map((title) => String(title))
    .filter((title) => title.length > 0);
  const sourceText = (Array.isArray(summary.sources) ? summary.sources : [])
    .map((item) => String(item))
    .filter((item) => item.length > 0)
    .join(", ");
  let prefix = `${toolName} 返回 ${count} 条结果`;
  if (sourceText) {
    prefix = `${prefix}（${sourceText}）`;
  }
  const errorMessage = summary.error_message;
  if (errorMessage) {
    prefix = `${prefix}；部分来源失败：${String(errorMessage)}`;
  }
  if (titles.length > 0) {
    return `${prefix}，我会优先参考：${titles.join("; ")}`;
  }
  return `${prefix}，但没有可展示的标题。`;
}

export function streamChunks(content: string, maxChars = 36): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const char of content) {
    current += char;
    if (["\n", "。", "？", "！", ".", "?", "!"].includes(char) || current.length >= maxChars) {
      chunks.push(current);
      current = "";
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks.length > 0 ? chunks : [""];
}

export function languageFromText(text: string): string {
  return [...text].some((char) => char >= "\u4e00" && char <= "\u9fff") ? "zh" : "en";
}

export function assistantSummary(
  diagnosis: {
    problem: string;
    gap: string;
    candidate_mechanism: string;
    evidence_needed: string[];
    main_uncertainty: string;
    clarifying_questions: string[];
  },
  isSessionStart: boolean,
  language = "en",
): string {
  const questions = diagnosis.clarifying_questions.map((question) => `- ${question}`).join("\n");
  const evidence = diagnosis.evidence_needed.map((item) => `- ${item}`).join("\n");
  if (language === "zh") {
    const prefix = isSessionStart ? "已生成五字段诊断。\n\n" : "";
    return (
      `${prefix}` +
      `问题：${diagnosis.problem}\n\n` +
      `差距：${diagnosis.gap}\n\n` +
      `候选机制：${diagnosis.candidate_mechanism}\n\n` +
      `需要的证据：\n${evidence}\n\n` +
      `主要不确定性：${diagnosis.main_uncertainty}\n\n` +
      `澄清问题：\n${questions}`
    );
  }
  const prefix = isSessionStart ? "Updated five-field diagnosis created.\n\n" : "";
  return (
    `${prefix}` +
    `Problem: ${diagnosis.problem}\n\n` +
    `Gap: ${diagnosis.gap}\n\n` +
    `Candidate Mechanism: ${diagnosis.candidate_mechanism}\n\n` +
    `Evidence Needed:\n${evidence}\n\n` +
    `Main uncertainty: ${diagnosis.main_uncertainty}\n\n` +
    `Clarifying Questions:\n${questions}`
  );
}

export function fallbackDiagnosis(idea: string): never {
  throw new Error(
    `LLM diagnosis extraction failed for idea "${idea.trim().slice(0, 80)}". Re-run with a configured provider.`,
  );
}

export function fallbackTitle(idea: string): string {
  const cleaned = idea.trim().split(/\s+/).join(" ");
  if (cleaned.length > 60) {
    return `${cleaned.slice(0, 57).trimEnd()}...`;
  }
  return cleaned || "Untitled Research Idea";
}

export function fallbackTitleFromMessages(
  messages: Array<{role: string; content: string}>,
): string {
  for (const message of [...messages].reverse()) {
    if (message.role === "user" && message.content.trim()) {
      return fallbackTitle(message.content);
    }
  }
  return "Untitled Research Idea";
}

export function isPlaceholderTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase().split(/\s+/).join(" ");
  return normalized.length === 0 || normalized.startsWith("untitled");
}

export function providerResponseToRecord(response: ProviderResponse): Record<string, unknown> {
  return {
    response_id: response.response_id,
    request_id: response.request_id,
    provider: response.provider,
    model: response.model,
    output: response.output,
    usage: response.usage,
    cached: response.cached,
    provider_request_id: response.provider_request_id,
    created_at: response.created_at,
  };
}

export function extractToolCalls(output: JsonObject): ToolCall[] {
  const raw = output.tool_calls;
  if (!Array.isArray(raw)) {
    return [];
  }
  const toolCalls: ToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    toolCalls.push({
      call_id: String(record.call_id ?? ""),
      name: String(record.name ?? ""),
      arguments:
        record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments)
          ? (record.arguments as Record<string, unknown>)
          : {},
    });
  }
  return toolCalls;
}
