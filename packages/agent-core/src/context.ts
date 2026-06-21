import {AgentConfig, ContextCompactionConfig} from "@academic-agent/config";
import {ArtifactManager, MemoryManager} from "@academic-agent/harness";
import {agentSystemPrompt} from "@academic-agent/providers";
import {
  newId,
  utcNow,
  type ContextUsageResponse,
  type ConversationSummary,
  type ThreadMessage,
} from "@academic-agent/schemas";
import type {WorkspacePort} from "@academic-agent/workspace-port";

export type HistoryContextPacket = {
  compacted: boolean;
  total_message_count: number;
  older_message_count: number;
  recent_message_count: number;
  important_message_count: number;
  prompt_text: string;
  source_refs: string[];
  artifact_source_refs: string[];
  important_source_refs: string[];
  excluded_context_summary: string;
  compact_reason: string;
  context_focus: string;
  estimated_history_tokens: number;
  history_token_budget: number;
  compact_threshold_tokens: number;
  context_window_tokens: number;
  recent_token_budget: number;
  important_token_budget: number;
  summary_token_budget: number;
  artifact_context_tokens: number;
  artifact_token_budget: number;
  persistent_summary_id: string | null;
  persistent_summary_path: string | null;
  persistent_summary_covered_until_ordinal: number | null;
};

export type ArtifactContextPacket = {
  prompt_text: string;
  source_refs: string[];
  estimated_tokens: number;
  token_budget: number;
};

export const COMPACT_RECENT_MESSAGE_LIMIT = 8;
export const COMPACT_SUMMARY_CHAR_LIMIT = 3600;
export const COMPACT_RECENT_CHAR_LIMIT = 6000;
export const COMPACT_MESSAGE_CHAR_LIMIT = 900;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 16_000;

export const MODEL_CONTEXT_WINDOW_HINTS: ReadonlyArray<readonly [string, number]> = [
  ["gpt-5", 128_000],
  ["gpt-4.1", 1_000_000],
  ["gpt-4o", 128_000],
  ["claude", 200_000],
  ["deepseek", 64_000],
];

export const CONTEXT_FOCUS_KEYWORDS: Record<string, readonly string[]> = {
  literature: [
    "论文",
    "文献",
    "paper",
    "arxiv",
    "preprint",
    "openreview",
    "related work",
    "novelty",
    "最新论文",
    "最新文献",
    "最新预印本",
    "检索",
  ],
  experiment: [
    "实验",
    "baseline",
    "metric",
    "ablation",
    "benchmark",
    "数据集",
    "评测",
    "human evaluation",
  ],
  result_analysis: [
    "结果",
    "分析",
    "显著性",
    "error analysis",
    "失败案例",
    "support",
    "falsify",
    "weaken",
  ],
  writing: [
    "写作",
    "paper",
    "abstract",
    "introduction",
    "related work",
    "rebuttal",
    "camera-ready",
    "投稿",
  ],
  execution: [
    "代码",
    "实现",
    "bug",
    "报错",
    "测试",
    "api",
    "tui",
    "fastapi",
    "typescript",
    "python",
  ],
  memory: ["compact", "上下文", "记忆", "memory", "resume", "session", "历史", "trace"],
  idea_plan: ["idea", "计划", "plan", "顶会", "创新", "算法", "机制", "方向", "claim"],
};

export const IMPORTANT_KEYWORDS = [
  "必须",
  "不要",
  "不能",
  "优先",
  "约束",
  "决定",
  "确认",
  "纠正",
  "不是",
  "应该",
  "保留",
  "冻结",
  "frozen",
  "advance",
  "reject",
  "revise",
  "claim",
  "baseline",
  "ablation",
  "novelty",
  "顶会",
  "算法",
  "安全",
] as const;

const SENSITIVE_ASSIGNMENT_RE = /\b(api[_-]?key|token|secret|password)\s*[:=]\s*([^\s,;]+)/gi;
const SENSITIVE_TOKEN_RE =
  /\b(sk-[a-z0-9_-]{12,}|sk-ant-[a-z0-9_-]{12,}|[a-z0-9_-]{24,}\.[a-z0-9_-]{12,}\.[a-z0-9_-]{12,})\b/gi;

export function modelContextWindow(model: string, config: ContextCompactionConfig): number {
  if (config.context_window_tokens) {
    return config.context_window_tokens;
  }
  const normalized = model.toLowerCase();
  for (const [marker, window] of MODEL_CONTEXT_WINDOW_HINTS) {
    if (normalized.includes(marker)) {
      return window;
    }
  }
  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export function historyTokenBudget(
  config: ContextCompactionConfig,
  model: string,
  maxOutputTokens: number,
): number {
  const modelWindow = modelContextWindow(model, config);
  const available =
    modelWindow - maxOutputTokens - config.response_token_reserve - config.system_tool_token_reserve;
  return Math.max(64, Math.min(config.max_history_tokens, available));
}

export function compactThresholdTokens(
  config: ContextCompactionConfig,
  historyTokenBudgetValue: number,
): number {
  return Math.max(1, Math.floor(historyTokenBudgetValue * config.compact_trigger_ratio));
}

export function recentTokenBudget(
  config: ContextCompactionConfig,
  historyTokenBudgetValue: number,
  recentCharLimit: number | null,
): number {
  if (recentCharLimit !== null) {
    return Math.max(1, Math.floor(recentCharLimit / Math.max(1.0, config.chars_per_token)));
  }
  return Math.max(128, Math.floor(historyTokenBudgetValue * config.recent_token_ratio));
}

export function artifactTokenBudget(
  config: ContextCompactionConfig,
  historyTokenBudgetValue: number,
): number {
  const ratioBudget = Math.max(400, Math.floor(historyTokenBudgetValue * config.artifact_token_ratio));
  return Math.max(400, Math.min(config.artifact_max_tokens, ratioBudget));
}

export function prependArtifactContext(historyPrompt: string, artifactContextText: string): string {
  if (!artifactContextText.trim()) {
    return historyPrompt;
  }
  return (
    "Artifact memory context (highest priority, source-referenced):\n" +
    `${artifactContextText.trim()}\n\n` +
    historyPrompt
  );
}

export function buildArtifactContext(
  workspace: WorkspacePort,
  artifactManager: ArtifactManager,
  threadId: string,
  compactionConfig: ContextCompactionConfig,
  model: string,
  maxOutputTokens: number,
  latestInput = "",
): ArtifactContextPacket {
  const historyBudget = historyTokenBudget(compactionConfig, model, maxOutputTokens);
  const tokenBudget = artifactTokenBudget(compactionConfig, historyBudget);
  const charsPerToken = Math.max(1.0, compactionConfig.chars_per_token);
  const charBudget = Math.max(600, Math.floor(tokenBudget * charsPerToken));
  const lines: string[] = [];
  const sourceRefs: string[] = [];

  const planMetadata = workspace.latest_plan_artifact_for_thread(threadId);
  if (planMetadata !== null) {
    sourceRefs.push(`artifact:${planMetadata.artifact_id}`);
    try {
      let diagnosis;
      let status: string;
      let title: string;
      if (planMetadata.artifact_type === "ResearchIdeaPlan") {
        const [, plan] = artifactManager.read_research_idea_plan(planMetadata.artifact_id);
        diagnosis = plan.diagnosis;
        status = plan.status;
        title = plan.title;
      } else {
        const [, draft] = artifactManager.read_research_idea_draft(planMetadata.artifact_id);
        diagnosis = draft.diagnosis;
        status = "draft";
        title = draft.title;
      }
      lines.push(
        "## Current Research Idea Artifact",
        `- Artifact: \`${planMetadata.artifact_id}\` (${planMetadata.artifact_type}, ${status})`,
        `- Path: \`${planMetadata.path}\``,
        `- Title: ${title}`,
        `- Problem: ${truncateOneLine(diagnosis.problem, 420)}`,
        `- Gap: ${truncateOneLine(diagnosis.gap, 420)}`,
        `- Candidate Mechanism: ${truncateOneLine(diagnosis.candidate_mechanism, 420)}`,
        `- Main Uncertainty: ${truncateOneLine(diagnosis.main_uncertainty, 420)}`,
        `- Evidence Needed: ${diagnosis.evidence_needed
          .slice(0, 5)
          .map((item) => truncateOneLine(item, 180))
          .join(" | ")}`,
      );
      if (diagnosis.clarifying_questions.length > 0) {
        lines.push(
          `- Clarifying Questions: ${diagnosis.clarifying_questions
            .slice(0, 4)
            .map((item) => truncateOneLine(item, 160))
            .join(" | ")}`,
        );
      }
    } catch (error) {
      lines.push(
        "## Current Research Idea Artifact",
        `- Artifact: \`${planMetadata.artifact_id}\` (${planMetadata.artifact_type})`,
        `- Read error: ${truncateOneLine(String(error), 240)}`,
      );
    }
  }

  const review = workspace.latest_idea_review(threadId);
  if (review !== null) {
    sourceRefs.push(`review:${String(review.review_id)}`);
    lines.push(
      "",
      "## Latest Idea Review Gate",
      `- Review: \`${String(review.review_id)}\``,
      `- Decision: \`${String(review.decision)}\``,
      `- Artifact: \`${String(review.artifact_id)}\``,
      `- Created at: \`${String(review.created_at)}\``,
      `- Notes: ${truncateOneLine(String(review.notes ?? "None"), 520)}`,
    );
  }

  const evidenceLimit = Math.max(0, compactionConfig.paper_evidence_limit);
  const evidenceArtifacts = workspace.latest_artifacts_for_thread(
    threadId,
    "PaperSearchEvidence",
    evidenceLimit,
  );
  if (evidenceArtifacts.length > 0) {
    lines.push("", `## Recent Paper Search Evidence (${evidenceArtifacts.length})`);
  }
  for (const metadata of evidenceArtifacts) {
    sourceRefs.push(`paper_evidence:${metadata.artifact_id}`);
    try {
      const [, evidence] = artifactManager.read_paper_search_evidence(metadata.artifact_id);
      const response = evidence.search_response;
      const titles = response.results
        .slice(0, 5)
        .filter((result) => result.title)
        .map((result) => truncateOneLine(result.title, 180));
      lines.push(
        `- Evidence: \`${metadata.artifact_id}\``,
        `  - Query: ${evidence.query}`,
        `  - Source: \`${response.source}\`; retrieved_at: \`${response.retrieved_at}\``,
        `  - Result count: \`${response.results.length}\``,
        `  - Error: ${truncateOneLine(String(response.error ?? "None"), 240)}`,
        `  - Top titles: ${titles.length > 0 ? titles.join(" | ") : "None"}`,
      );
    } catch (error) {
      lines.push(
        `- Evidence: \`${metadata.artifact_id}\``,
        `  - Read error: ${truncateOneLine(String(error), 240)}`,
      );
    }
  }

  const memoryQuery = latestInput.trim();
  const memoryHits = memoryQuery
    ? new MemoryManager(workspace).search_memory(memoryQuery, threadId, 6).results
    : [];
  if (memoryHits.length > 0) {
    lines.push("", `## Retrieved Memory Records (${memoryHits.length})`);
  }
  for (const hit of memoryHits) {
    const record = hit.record;
    sourceRefs.push(`memory:${record.record_id}`);
    lines.push(
      `- Memory: \`${record.record_id}\` (${record.record_type}, score=${hit.score})`,
      `  - Title: ${record.title}`,
      `  - Status: \`${record.status}\`; reason: ${hit.reason}`,
      `  - Summary: ${truncateOneLine(record.summary, 520)}`,
      `  - Source refs: ${record.source_refs.slice(0, 8).join(", ") || "None"}`,
    );
  }

  const openConflicts = workspace.list_conflict_records(threadId, "open", 5);
  if (openConflicts.length > 0) {
    lines.push("", `## Open Memory Conflicts (${openConflicts.length})`);
  }
  for (const conflict of openConflicts) {
    sourceRefs.push(`conflict:${conflict.conflict_id}`);
    lines.push(
      `- Conflict: \`${conflict.conflict_id}\` (${conflict.conflict_type})`,
      `  - Summary: ${truncateOneLine(conflict.summary, 520)}`,
      `  - Source refs: ${conflict.source_refs.slice(0, 8).join(", ") || "None"}`,
    );
  }

  if (lines.length === 0) {
    return {
      prompt_text: "",
      source_refs: [],
      estimated_tokens: 0,
      token_budget: tokenBudget,
    };
  }

  const promptText = truncatePreservingLines(lines.join("\n"), charBudget);
  return {
    prompt_text: promptText,
    source_refs: sourceRefs,
    estimated_tokens: estimateTextTokens(promptText, charsPerToken),
    token_budget: tokenBudget,
  };
}

export function estimateMessagesChars(messages: ThreadMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

export function estimateMessagesTokens(messages: ThreadMessage[], charsPerToken: number): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message, charsPerToken), 0);
}

export function estimateTextTokens(text: string, charsPerToken: number): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.floor((text.length + 16) / charsPerToken));
}

export function estimateMessageTokens(message: ThreadMessage, charsPerToken: number): number {
  return Math.max(1, Math.floor((message.content.length + message.role.length + 16) / charsPerToken));
}

export function safeRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0.0;
  }
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

export function detectContextFocus(latestInput: string): string {
  const text = latestInput.toLowerCase();
  let bestFocus = "idea_plan";
  let bestScore = 0;
  for (const [focus, keywords] of Object.entries(CONTEXT_FOCUS_KEYWORDS)) {
    const score = keywords.filter((keyword) => text.includes(keyword.toLowerCase())).length;
    if (score > bestScore) {
      bestScore = score;
      bestFocus = focus;
    }
  }
  return bestFocus;
}

export function selectImportantMessages(
  messages: ThreadMessage[],
  latestInput: string,
  contextFocus: string,
  tokenBudget: number,
  limit: number,
  charsPerToken: number,
  perMessageTokenLimit: number,
): ThreadMessage[] {
  if (messages.length === 0 || tokenBudget <= 0 || limit <= 0) {
    return [];
  }
  const maxOrdinal = messages[messages.length - 1]?.ordinal ?? 0;
  const scored = messages.map((message) => ({
    score: scoreMessageImportance(message, latestInput, contextFocus, maxOrdinal),
    message,
  }));
  const selected: ThreadMessage[] = [];
  let usedTokens = 0;
  for (const {score, message} of [...scored].sort(
    (left, right) => right.score - left.score || right.message.ordinal - left.message.ordinal,
  )) {
    if (score < 2.2) {
      continue;
    }
    const messageTokens = Math.min(
      estimateMessageTokens(message, charsPerToken),
      perMessageTokenLimit,
    );
    if (selected.length > 0 && usedTokens + messageTokens > tokenBudget) {
      continue;
    }
    selected.push(message);
    usedTokens += messageTokens;
    if (selected.length >= limit) {
      break;
    }
  }
  return selected.sort((left, right) => left.ordinal - right.ordinal);
}

function scoreMessageImportance(
  message: ThreadMessage,
  latestInput: string,
  contextFocus: string,
  maxOrdinal: number,
): number {
  const content = message.content.toLowerCase();
  let score = message.role === "assistant" ? 0.4 : 0.8;
  if (maxOrdinal > 0) {
    score += Math.min(1.2, message.ordinal / maxOrdinal);
  }
  score += Math.min(3.0, 0.55 * keywordCount(content, IMPORTANT_KEYWORDS));
  const focusKeywords = CONTEXT_FOCUS_KEYWORDS[contextFocus] ?? [];
  score += Math.min(2.5, 0.7 * keywordCount(content, focusKeywords));
  score += Math.min(2.0, 0.35 * latestInputOverlap(content, latestInput));
  if (message.content.includes("?") || message.content.includes("？")) {
    score += 0.8;
  }
  if (["Problem:", "Gap:", "问题：", "差距："].some((marker) => message.content.includes(marker))) {
    score += 1.2;
  }
  if (content.includes("error") || content.includes("报错") || content.includes("失败")) {
    score += 1.0;
  }
  return score;
}

function keywordCount(text: string, keywords: readonly string[]): number {
  return keywords.filter((keyword) => text.includes(keyword.toLowerCase())).length;
}

function latestInputOverlap(content: string, latestInput: string): number {
  const terms = new Set(
    latestInput
      .toLowerCase()
      .replace(/\//g, " ")
      .replace(/_/g, " ")
      .split(/\s+/)
      .filter((term) => term.length >= 3),
  );
  let overlap = 0;
  for (const term of terms) {
    if (content.includes(term)) {
      overlap += 1;
    }
  }
  return overlap;
}

function compactReason(
  tokenBudgetTrigger: boolean,
  exactHistoryMessageTrigger: boolean,
  exactHistoryCharTrigger: boolean,
  estimatedHistoryTokens: number,
  compactThresholdTokensValue: number,
): string {
  const reasons: string[] = [];
  if (tokenBudgetTrigger) {
    reasons.push(
      `history token estimate exceeded compact threshold (${estimatedHistoryTokens}/${compactThresholdTokensValue})`,
    );
  }
  if (exactHistoryMessageTrigger) {
    reasons.push("explicit recent message window exceeded");
  }
  if (exactHistoryCharTrigger) {
    reasons.push("explicit recent character window exceeded");
  }
  return reasons.length > 0 ? reasons.join("; ") : "history compacted by policy";
}

export function buildHistoryContext(
  history: ThreadMessage[],
  options: {
    persistentSummary?: ConversationSummary | null;
    latestInput?: string;
    compactionConfig?: ContextCompactionConfig | null;
    model?: string;
    maxOutputTokens?: number;
    artifactContext?: ArtifactContextPacket | null;
    recentMessageLimit?: number | null;
    summaryCharLimit?: number | null;
    recentCharLimit?: number | null;
  } = {},
): HistoryContextPacket {
  const config = options.compactionConfig ?? new ContextCompactionConfig({});
  const latestInput = options.latestInput ?? "";
  const model = options.model ?? "";
  const maxOutputTokens = options.maxOutputTokens ?? 900;
  const persistentSummary = options.persistentSummary ?? null;
  const artifactContext = options.artifactContext ?? null;
  const recentMessageLimit = options.recentMessageLimit ?? null;
  const summaryCharLimit = options.summaryCharLimit ?? null;
  const recentCharLimit = options.recentCharLimit ?? null;

  const charsPerToken = Math.max(1.0, config.chars_per_token);
  const contextFocus = detectContextFocus(latestInput);
  const contextWindowTokens = modelContextWindow(model, config);
  const historyTokenBudgetValue = historyTokenBudget(config, model, maxOutputTokens);
  const compactThresholdTokensValue = compactThresholdTokens(config, historyTokenBudgetValue);
  const recentTokenBudgetValue = recentTokenBudget(config, historyTokenBudgetValue, recentCharLimit);
  const importantTokenBudget = Math.max(
    1,
    Math.floor(historyTokenBudgetValue * config.important_token_ratio),
  );
  const summaryTokenBudget =
    summaryCharLimit !== null
      ? Math.max(1, Math.floor(summaryCharLimit / charsPerToken))
      : Math.max(1, Math.floor(historyTokenBudgetValue * config.summary_token_ratio));
  const artifactContextText = artifactContext?.prompt_text ?? "";
  const artifactSourceRefs = artifactContext?.source_refs ?? [];
  const artifactContextTokens = artifactContext?.estimated_tokens ?? 0;
  const artifactTokenBudgetValue =
    artifactContext?.token_budget ?? artifactTokenBudget(config, historyTokenBudgetValue);
  const maxRecentMessages = recentMessageLimit ?? config.max_recent_messages;
  const minRecentMessages = Math.min(config.min_recent_messages, maxRecentMessages);
  const perMessageCharLimit = Math.max(120, Math.floor(config.per_message_token_limit * charsPerToken));

  const nonToolHistory = history.filter((message) => message.role !== "tool");
  const estimatedHistoryTokens = estimateMessagesTokens(nonToolHistory, charsPerToken);

  if (nonToolHistory.length === 0) {
    return {
      compacted: false,
      total_message_count: 0,
      older_message_count: 0,
      recent_message_count: 0,
      important_message_count: 0,
      prompt_text: prependArtifactContext(
        "No previous discussion in this thread.",
        artifactContextText,
      ),
      source_refs: artifactSourceRefs,
      artifact_source_refs: artifactSourceRefs,
      important_source_refs: [],
      excluded_context_summary: "No previous non-tool messages.",
      compact_reason: "no previous non-tool messages",
      context_focus: contextFocus,
      estimated_history_tokens: 0,
      history_token_budget: historyTokenBudgetValue,
      compact_threshold_tokens: compactThresholdTokensValue,
      context_window_tokens: contextWindowTokens,
      recent_token_budget: recentTokenBudgetValue,
      important_token_budget: importantTokenBudget,
      summary_token_budget: summaryTokenBudget,
      artifact_context_tokens: artifactContextTokens,
      artifact_token_budget: artifactTokenBudgetValue,
      persistent_summary_id: persistentSummary?.summary_id ?? null,
      persistent_summary_path: persistentSummary?.markdown_path ?? null,
      persistent_summary_covered_until_ordinal: persistentSummary?.covered_until_ordinal ?? null,
    };
  }

  const exactHistoryMessageTrigger =
    recentMessageLimit !== null && nonToolHistory.length > recentMessageLimit;
  const exactHistoryCharTrigger =
    recentCharLimit !== null && estimateMessagesChars(nonToolHistory) > recentCharLimit;
  const tokenBudgetTrigger = estimatedHistoryTokens > compactThresholdTokensValue;
  const compacted = Boolean(
    config.enabled &&
      (tokenBudgetTrigger || exactHistoryMessageTrigger || exactHistoryCharTrigger),
  );

  let recentMessages = selectRecentMessages(
    nonToolHistory,
    maxRecentMessages,
    minRecentMessages,
    recentTokenBudgetValue,
    charsPerToken,
    config.per_message_token_limit,
  );
  const messageSourceRefs = nonToolHistory.map((message) => `msg:${message.ordinal}`);
  const sourceRefs = [...artifactSourceRefs, ...messageSourceRefs];

  let olderMessages: ThreadMessage[] = [];
  let importantMessages: ThreadMessage[] = [];
  let compactReasonText: string;
  let historyPrompt: string;
  let excluded: string;

  if (compacted) {
    const recentOrdinals = new Set(recentMessages.map((message) => message.ordinal));
    olderMessages = nonToolHistory.filter((message) => !recentOrdinals.has(message.ordinal));
    importantMessages = selectImportantMessages(
      olderMessages,
      latestInput,
      contextFocus,
      importantTokenBudget,
      config.important_message_limit,
      charsPerToken,
      config.per_message_token_limit,
    );
    const olderSummary =
      persistentSummary?.summary_text ??
      summarizeOlderMessages(
        olderMessages,
        Math.floor(summaryTokenBudget * charsPerToken),
      );
    const olderHeader = persistentSummary
      ? "Persistent conversation summary"
      : "Older compact summary";
    const importantBlock =
      importantMessages.length > 0
        ? `\n\nHigh-importance older snippets (${importantMessages.length} messages):\n${formatRecentTranscript(importantMessages, perMessageCharLimit)}`
        : "";
    compactReasonText = compactReason(
      tokenBudgetTrigger,
      exactHistoryMessageTrigger,
      exactHistoryCharTrigger,
      estimatedHistoryTokens,
      compactThresholdTokensValue,
    );
    historyPrompt =
      "Context compaction policy:\n" +
      "- Full transcript is stored locally in SQLite and trace; this packet is a " +
      "compressed view for the current LLM call.\n" +
      "- Priority 0 is artifact memory: the current ResearchIdeaPlan state, latest " +
      "review gate, and paper-search evidence. Layer 2 is a persistent " +
      "source-referenced conversation summary. Layer 1 keeps the most recent " +
      "messages and high-importance older snippets verbatim for this call.\n" +
      `- Current context focus: ${contextFocus}.\n` +
      `- Estimated history tokens: ${estimatedHistoryTokens}; history budget: ` +
      `${historyTokenBudgetValue}; compact threshold: ${compactThresholdTokensValue}; ` +
      `recent budget: ${recentTokenBudgetValue}; important snippet budget: ` +
      `${importantTokenBudget}; summary budget: ${summaryTokenBudget}; ` +
      `artifact budget: ${artifactTokenBudgetValue}.\n` +
      "- Treat compacted older history as lossy. Ask the user or inspect stored " +
      "artifacts if a missing detail matters.\n\n" +
      `${olderHeader} (${olderMessages.length} older messages):\n` +
      `${olderSummary}` +
      `${importantBlock}\n\n` +
      `Recent exact transcript (${recentMessages.length} messages):\n` +
      `${formatRecentTranscript(recentMessages, perMessageCharLimit)}`;
    excluded =
      `${compactReasonText}; ${olderMessages.length} older non-tool messages were summarized; ` +
      `${importantMessages.length} important older messages and ` +
      `${recentMessages.length} recent messages were kept verbatim; ` +
      `${artifactSourceRefs.length} artifact memory refs were injected.`;
  } else {
    olderMessages = [];
    importantMessages = [];
    recentMessages = nonToolHistory;
    compactReasonText = !config.enabled
      ? "context compaction disabled"
      : `history fits token budget (${estimatedHistoryTokens}/${compactThresholdTokensValue} estimated tokens)`;
    historyPrompt =
      `Recent exact transcript (${recentMessages.length} messages):\n` +
      formatRecentTranscript(recentMessages, perMessageCharLimit);
    excluded =
      `No older messages were summarized; ${compactReasonText}; ` +
      `${artifactSourceRefs.length} artifact memory refs were injected.`;
  }

  return {
    compacted,
    total_message_count: nonToolHistory.length,
    older_message_count: olderMessages.length,
    recent_message_count: recentMessages.length,
    important_message_count: importantMessages.length,
    prompt_text: prependArtifactContext(historyPrompt, artifactContextText),
    source_refs: sourceRefs,
    artifact_source_refs: artifactSourceRefs,
    important_source_refs: importantMessages.map((message) => `msg:${message.ordinal}`),
    excluded_context_summary: excluded,
    compact_reason: compactReasonText,
    context_focus: contextFocus,
    estimated_history_tokens: estimatedHistoryTokens,
    history_token_budget: historyTokenBudgetValue,
    compact_threshold_tokens: compactThresholdTokensValue,
    context_window_tokens: contextWindowTokens,
    recent_token_budget: recentTokenBudgetValue,
    important_token_budget: importantTokenBudget,
    summary_token_budget: summaryTokenBudget,
    artifact_context_tokens: artifactContextTokens,
    artifact_token_budget: artifactTokenBudgetValue,
    persistent_summary_id: persistentSummary?.summary_id ?? null,
    persistent_summary_path: persistentSummary?.markdown_path ?? null,
    persistent_summary_covered_until_ordinal: persistentSummary?.covered_until_ordinal ?? null,
  };
}

export function buildContextUsage(
  workspace: WorkspacePort,
  threadId: string | null = null,
  draftInput = "",
): ContextUsageResponse {
  const config = AgentConfig.load(workspace.projectRoot);
  const profile = config.profile("planner");
  const compaction = config.context_compaction;
  const messages = threadId ? workspace.list_messages(threadId) : [];
  const artifactContext = threadId
    ? buildArtifactContext(
        workspace,
        new ArtifactManager(workspace),
        threadId,
        compaction,
        profile.model,
        profile.max_output_tokens,
        draftInput,
      )
    : null;
  const historyContext = buildHistoryContext(messages, {
    latestInput: draftInput,
    compactionConfig: compaction,
    model: profile.model,
    maxOutputTokens: profile.max_output_tokens,
    artifactContext,
  });
  const charsPerToken = Math.max(1.0, compaction.chars_per_token);
  const draftTokens = estimateTextTokens(draftInput, charsPerToken);
  const estimatedThreadTokens = historyContext.estimated_history_tokens;
  const estimatedArtifactTokens = historyContext.artifact_context_tokens;
  const estimatedTotalTokens = estimatedThreadTokens + estimatedArtifactTokens + draftTokens;
  const contextWindowTokens = historyContext.context_window_tokens;
  const estimatedContextTokens = Math.min(
    contextWindowTokens,
    profile.max_output_tokens +
      compaction.response_token_reserve +
      compaction.system_tool_token_reserve +
      estimatedTotalTokens,
  );
  return {
    thread_id: threadId,
    model: profile.model,
    context_window_tokens: contextWindowTokens,
    history_token_budget: historyContext.history_token_budget,
    compact_threshold_tokens: historyContext.compact_threshold_tokens,
    compact_trigger_ratio: compaction.compact_trigger_ratio,
    max_history_tokens: compaction.max_history_tokens,
    estimated_thread_tokens: estimatedThreadTokens,
    estimated_artifact_tokens: estimatedArtifactTokens,
    estimated_draft_tokens: draftTokens,
    estimated_total_tokens: estimatedTotalTokens,
    estimated_context_tokens: estimatedContextTokens,
    usage_ratio: safeRatio(estimatedContextTokens, contextWindowTokens),
    threshold_ratio: safeRatio(
      estimatedThreadTokens,
      historyContext.compact_threshold_tokens,
    ),
    should_compact: historyContext.compacted,
    compact_reason: historyContext.compact_reason,
    context_focus: historyContext.context_focus,
    total_message_count: historyContext.total_message_count,
    recent_message_count: historyContext.recent_message_count,
    older_message_count: historyContext.older_message_count,
    important_message_count: historyContext.important_message_count,
    artifact_source_count: historyContext.artifact_source_refs.length,
    chars_per_token: charsPerToken,
  };
}

export function buildThreadArtifactContext(
  workspace: WorkspacePort,
  threadId: string,
  draftInput = "",
): ArtifactContextPacket {
  const config = AgentConfig.load(workspace.projectRoot);
  const profile = config.profile("planner");
  return buildArtifactContext(
    workspace,
    new ArtifactManager(workspace),
    threadId,
    config.context_compaction,
    profile.model,
    profile.max_output_tokens,
    draftInput,
  );
}

function selectRecentMessages(
  messages: ThreadMessage[],
  maxRecentMessages: number,
  minRecentMessages: number,
  recentTokenBudgetValue: number,
  charsPerToken: number,
  perMessageTokenLimit: number,
): ThreadMessage[] {
  const selected: ThreadMessage[] = [];
  let totalTokens = 0;
  for (const message of [...messages].reverse()) {
    const messageTokens = Math.min(
      estimateMessageTokens(message, charsPerToken),
      perMessageTokenLimit,
    );
    if (selected.length > 0 && selected.length >= maxRecentMessages) {
      break;
    }
    if (
      selected.length > 0 &&
      selected.length >= minRecentMessages &&
      totalTokens + messageTokens > recentTokenBudgetValue
    ) {
      break;
    }
    selected.push(message);
    totalTokens += messageTokens;
  }
  return selected.reverse();
}

export function summarizeOlderMessages(messages: ThreadMessage[], charLimit: number): string {
  const userGoals = collectUserGoals(messages);
  const constraints = collectConstraints(messages);
  const conclusions = collectAssistantConclusions(messages);
  const openQuestions = collectOpenQuestions(messages);
  const timeline = messages.slice(-6).map(
    (message) =>
      `- ${message.role.toUpperCase()}[${message.ordinal}]: ${truncateOneLine(message.content, 180)}`,
  );
  const sections: Array<[string, string[]]> = [
    ["User goals / topic updates", userGoals],
    ["User constraints / preferences", constraints],
    ["Agent conclusions / diagnosis updates", conclusions],
    ["Open questions / unresolved items", openQuestions],
    ["Recent older-message timeline", timeline],
  ];
  const lines: string[] = [];
  for (const [title, items] of sections) {
    if (items.length === 0) {
      continue;
    }
    lines.push(`${title}:`);
    lines.push(...items.slice(0, 8));
  }
  if (lines.length === 0) {
    lines.push("- Older messages existed but contained no compactable non-empty text.");
  }
  return truncatePreservingLines(lines.join("\n"), charLimit);
}

export function buildConversationSummary(
  threadId: string,
  history: ThreadMessage[],
  historyContext: HistoryContextPacket,
  existing: ConversationSummary | null = null,
): ConversationSummary {
  const nonToolHistory = history.filter((message) => message.role !== "tool");
  const olderCount = historyContext.older_message_count;
  const olderMessages = nonToolHistory.slice(0, olderCount);
  const summaryText = summarizeOlderMessages(
    olderMessages,
    Math.max(COMPACT_SUMMARY_CHAR_LIMIT, historyContext.summary_token_budget * 4),
  );
  const now = utcNow();
  const coveredUntil = olderMessages.length > 0 ? olderMessages[olderMessages.length - 1]!.ordinal : 0;
  const summaryId = existing?.summary_id ?? newId("convsum");
  const createdAt = existing?.created_at ?? now;
  const summaryDir = ".academic-agent/memory/conversation-summaries";
  return {
    summary_id: summaryId,
    thread_id: threadId,
    status: "frozen",
    schema_version: "v0",
    summary_source: "deterministic",
    provider: null,
    model: null,
    summary_text: summaryText,
    source_refs: olderMessages.map((message) => `msg:${message.ordinal}`),
    covered_until_ordinal: coveredUntil,
    covered_message_count: olderMessages.length,
    markdown_path: `${summaryDir}/${threadId}.md`,
    metadata_path: `${summaryDir}/${threadId}.json`,
    created_at: createdAt,
    updated_at: now,
  };
}

export function conversationSummarySystemPrompt(): string {
  return (
    "You are a context compaction assistant for an academic research agent. " +
    "Rewrite the provided deterministic conversation summary into a compact, " +
    "source-referenced long-term memory summary. Do not invent facts. Preserve " +
    "user goals, constraints, decisions, unresolved questions, and research direction. " +
    "Keep source refs like USER[3], ASSISTANT[4], or msg:4 when present. " +
    "Return plain text only, no markdown table, no JSON."
  );
}

export function conversationSummaryUserPrompt(
  summary: ConversationSummary,
  historyContext: HistoryContextPacket,
): string {
  return (
    "Deterministic summary to refine:\n" +
    `${summary.summary_text}\n\n` +
    "Compaction metadata:\n" +
    `- covered_message_count: ${summary.covered_message_count}\n` +
    `- covered_until_ordinal: ${summary.covered_until_ordinal}\n` +
    `- source_refs: ${summary.source_refs.slice(0, 80).join(", ")}\n` +
    `- excluded_context_summary: ${historyContext.excluded_context_summary}\n\n` +
    "Output a concise long-term memory summary in the same language mixture used by " +
    "the source conversation. Keep it under roughly 900 words."
  );
}

export function cleanSummaryText(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^`+/, "").trim();
    if (cleaned.includes("\n")) {
      const [firstLine, ...rest] = cleaned.split("\n");
      cleaned =
        firstLine?.trim().toLowerCase() === "text" ||
        firstLine?.trim().toLowerCase() === "markdown" ||
        firstLine?.trim().toLowerCase() === "md"
          ? rest.join("\n")
          : cleaned;
    }
  }
  return cleaned.trim();
}

function collectUserGoals(messages: ThreadMessage[]): string[] {
  return messages
    .filter((message) => message.role === "user" && message.content.trim())
    .slice(-8)
    .map((message) => `- USER[${message.ordinal}]: ${truncateOneLine(message.content, 220)}`);
}

function collectConstraints(messages: ThreadMessage[]): string[] {
  const keywords = [
    "必须",
    "不要",
    "不能",
    "优先",
    "只",
    "需要",
    "约束",
    "顶会",
    "算法",
    "中文",
    "英文",
    "latest",
    "recent",
    "current",
    "arxiv",
    "preprint",
  ];
  const constraints: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    const lowered = message.content.toLowerCase();
    if (keywords.some((keyword) => lowered.includes(keyword))) {
      constraints.push(`- USER[${message.ordinal}]: ${truncateOneLine(message.content, 220)}`);
    }
  }
  return constraints.slice(-8);
}

function collectAssistantConclusions(messages: ThreadMessage[]): string[] {
  const markers = [
    "Problem:",
    "Gap:",
    "Candidate Mechanism:",
    "Main uncertainty:",
    "问题：",
    "差距：",
    "候选机制：",
    "主要不确定性：",
    "结论",
    "不确定",
  ];
  const conclusions: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const matchingLines = message.content
      .split("\n")
      .filter((line) => markers.some((marker) => line.includes(marker)))
      .map((line) => truncateOneLine(line, 220));
    if (matchingLines.length > 0) {
      conclusions.push(
        ...matchingLines.slice(0, 4).map((line) => `- ASSISTANT[${message.ordinal}]: ${line}`),
      );
    } else {
      conclusions.push(
        `- ASSISTANT[${message.ordinal}]: ${truncateOneLine(message.content, 220)}`,
      );
    }
  }
  return conclusions.slice(-10);
}

function collectOpenQuestions(messages: ThreadMessage[]): string[] {
  const questions: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const line of message.content.split("\n")) {
      const stripped = line.trim();
      if (stripped.includes("?") || stripped.includes("？")) {
        questions.push(`- ASSISTANT[${message.ordinal}]: ${truncateOneLine(stripped, 220)}`);
      }
    }
  }
  return questions.slice(-8);
}

export function formatRecentTranscript(
  messages: ThreadMessage[],
  messageCharLimit = COMPACT_MESSAGE_CHAR_LIMIT,
): string {
  if (messages.length === 0) {
    return "No recent non-tool messages.";
  }
  return messages
    .map(
      (message) =>
        `${message.role.toUpperCase()}[${message.ordinal}]: ${truncateMultiline(message.content, messageCharLimit)}`,
    )
    .join("\n");
}

export function truncateOneLine(text: string, limit: number): string {
  return truncateText(text.trim().split(/\s+/).join(" "), limit);
}

export function truncateMultiline(text: string, limit: number): string {
  return truncateText(text.trim(), limit);
}

export function truncateText(text: string, limit: number): string {
  const redacted = redactSensitiveText(text);
  if (redacted.length <= limit) {
    return redacted;
  }
  return `${redacted.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function redactSensitiveText(text: string): string {
  const redacted = text.replace(SENSITIVE_ASSIGNMENT_RE, "$1=[REDACTED]");
  return redacted.replace(SENSITIVE_TOKEN_RE, "[REDACTED_SECRET]");
}

function truncatePreservingLines(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const lines: string[] = [];
  let total = 0;
  for (const line of text.split("\n")) {
    const projected = total + line.length + 1;
    if (projected > limit) {
      break;
    }
    lines.push(line);
    total = projected;
  }
  lines.push("- [truncated: older compact summary exceeded context budget]");
  return lines.join("\n");
}

export function buildInitialMessages(
  idea: string,
  historyContext: HistoryContextPacket,
): Array<Record<string, unknown>> {
  return [
    {role: "system", content: agentSystemPrompt()},
    {
      role: "user",
      content:
        `Thread history:\n${historyContext.prompt_text}\n\n` +
        `Latest user input:\n${idea}\n\n` +
        "Response language: use the same natural language as Latest user input for " +
        "all JSON string values. If Latest user input is Chinese, write the diagnosis " +
        "values and questions in Chinese. Keep JSON keys in English.\n" +
        "Research this idea using paper_search with sort_by='hybrid' to include both " +
        "relevant papers and recent arXiv preprints. If the user asks for latest, new, " +
        "recent, current, or today's papers/preprints, use sort_by='submitted_date'. " +
        "Use web_search only if paper_search is insufficient. " +
        "Then produce a final diagnosis JSON.",
    },
  ];
}

export function buildFinalSynthesisMessages(
  idea: string,
  messages: Array<Record<string, unknown>>,
  historyContext: HistoryContextPacket | Record<string, unknown>,
): Array<Record<string, unknown>> {
  const observations = summarizeToolObservations(messages);
  const assistantNotes = summarizeAssistantNotes(messages);
  const historySummary = String(
    ("excluded_context_summary" in historyContext
      ? historyContext.excluded_context_summary
      : "") ?? "",
  );
  return [
    {role: "system", content: agentSystemPrompt()},
    {
      role: "user",
      content:
        `Latest user input:\n${idea}\n\n` +
        `Thread context summary:\n${historySummary || "No compacted history summary."}\n\n` +
        `Tool observations:\n${observations}\n\n` +
        `Assistant intermediate notes:\n${assistantNotes}\n\n` +
        "Stop using tools. Do not request more searches. Based only on the user input, " +
        "thread context, and tool observations above, return one final diagnosis JSON " +
        "with exactly these keys: problem, gap, candidate_mechanism, evidence_needed, " +
        "main_uncertainty, clarifying_questions. Use the same natural language as the " +
        "latest user input for all string values. No markdown, no prose outside JSON.",
    },
  ];
}

export function summarizeToolObservations(messages: Array<Record<string, unknown>>): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== "tool") {
      continue;
    }
    const toolName = String(message.name ?? "tool");
    try {
      const payload = JSON.parse(String(message.content ?? "{}")) as Record<string, unknown>;
      const query = String(payload.query ?? "");
      const error = String(payload.error ?? "");
      const rawResults = payload.results;
      const results = Array.isArray(rawResults) ? rawResults : [];
      const titles = results
        .slice(0, 5)
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .filter((item) => item.title)
        .map((item) => truncateOneLine(String(item.title), 120));
      const sources = [
        ...new Set(
          results
            .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
            .map((item) => String(item.source ?? ""))
            .filter((source) => source.length > 0),
        ),
      ].sort();
      let line = `- ${toolName}`;
      if (query) {
        line += ` query=${truncateOneLine(query, 120)}`;
      }
      line += ` results=${results.length}`;
      if (sources.length > 0) {
        line += ` sources=${sources.join(", ")}`;
      }
      if (error) {
        line += ` partial_error=${truncateOneLine(error, 180)}`;
      }
      if (titles.length > 0) {
        line += ` titles=${titles.join("; ")}`;
      }
      lines.push(line);
    } catch {
      lines.push(`- ${toolName}: ${truncateOneLine(String(message.content ?? ""), 260)}`);
    }
  }
  return lines.length > 0 ? lines.slice(-12).join("\n") : "- No tool observations.";
}

export function summarizeAssistantNotes(messages: Array<Record<string, unknown>>): string {
  const notes: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const content = String(message.content ?? "").trim();
    if (content) {
      notes.push(`- ${truncateOneLine(content, 240)}`);
    }
  }
  return notes.length > 0 ? notes.slice(-5).join("\n") : "- No parseable intermediate assistant notes.";
}
