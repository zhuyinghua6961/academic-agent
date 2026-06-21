import type {ToolCall} from "@academic-agent/schemas";

export function uniqueToolNames(toolCalls: ToolCall[]): string[] {
  const names: string[] = [];
  for (const toolCall of toolCalls) {
    if (!names.includes(toolCall.name)) {
      names.push(toolCall.name);
    }
  }
  return names;
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
