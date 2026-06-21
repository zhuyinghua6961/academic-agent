import type {Diagnosis, ThreadMessage} from "@academic-agent/schemas";

export function systemPrompt(): string {
  return (
    "You are an academic research mentor and top-conference reviewer. " +
    "Diagnose the user's raw research idea. Return only valid JSON with this shape: " +
    '{"problem": string, "gap": string, "candidate_mechanism": string, ' +
    '"evidence_needed": string[], "main_uncertainty": string, ' +
    '"clarifying_questions": string[]}. ' +
    "Language contract: write every JSON string value in the same natural language " +
    "as the latest user input. If the latest user input is Chinese, all diagnosis " +
    "values and questions must be Chinese. Keep JSON keys in English. " +
    "Do not claim novelty without evidence. Be direct about uncertainty."
  );
}

export function agentSystemPrompt(): string {
  return (
    "You are an academic research mentor. Use paper_search for nearby papers and " +
    "academic related work; use web_search only as a fallback for non-paper information. " +
    "For novelty checks, call paper_search with sort_by='hybrid' so arXiv returns both " +
    "relevant papers and newly submitted preprints. When the user asks for latest, " +
    "new, recent, current, or today's papers/preprints, call paper_search with " +
    "sort_by='submitted_date'. " +
    "Language contract: write every JSON string value in the same natural language " +
    "as Latest user input. If Latest user input is Chinese, all diagnosis values, " +
    "evidence items, and questions must be Chinese. Keep JSON keys in English. " +
    "After search results appear, output ONLY a raw JSON object — no markdown, " +
    "no code fences, no XML tags, no tool_call syntax. The exact format:\n" +
    '{"problem":"...","gap":"...","candidate_mechanism":"...",' +
    '"evidence_needed":["..."],"main_uncertainty":"...",' +
    '"clarifying_questions":["..."]}\n' +
    "IMPORTANT: Never output <｜tool_calls｜> or <｜invoke or any XML. " +
    "Just the JSON."
  );
}

export function titleSystemPrompt(): string {
  return (
    "You name academic research planning conversations. " +
    "Return only one concise title, no quotes, no markdown, no punctuation at the end."
  );
}

export function titleUserPrompt(idea: string, diagnosis: Diagnosis): string {
  return (
    `Raw idea:\n${idea}\n\n` +
    `Problem diagnosis:\n${diagnosis.problem}\n\n` +
    "Write a 4-10 word title in the same language as the raw idea when possible."
  );
}

export function userPrompt(idea: string, history: ThreadMessage[]): string {
  const historyText = history
    .slice(-12)
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");
  const resolvedHistory = historyText || "No previous discussion in this thread.";
  return (
    `Thread history:\n${resolvedHistory}\n\n` +
    `Latest user input:\n${idea}\n\n` +
    "Response language: use the same natural language as Latest user input for " +
    "all JSON string values. Keep JSON keys in English.\n" +
    "Return an updated diagnosis JSON now. " +
    "Ask 2-4 clarifying_questions that would most improve top-conference-level idea planning."
  );
}

export function latestUserInputFromAgentContent(content: string): string {
  const marker = "Latest user input:\n";
  const markerIndex = content.indexOf(marker);
  const afterMarker = markerIndex >= 0 ? content.slice(markerIndex + marker.length) : content;
  for (const delimiter of [
    "\n\nResponse language",
    "\n\nResearch this idea",
    "\n\nReturn an updated diagnosis",
    "\n\nTool observations",
  ]) {
    if (afterMarker.includes(delimiter)) {
      return afterMarker.split(delimiter, 1)[0]?.trim() ?? afterMarker.trim();
    }
  }
  return afterMarker.trim();
}

export function historySignature(history: ThreadMessage[]): Array<{role: string; content: string}> {
  return history.map((message) => ({role: message.role, content: message.content}));
}

export function agentMessagesSignature(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const signature: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const item: Record<string, unknown> = {
      role: message.role,
      content: message.content,
    };
    if (message.tool_call_id) {
      item.tool_call_id = message.tool_call_id;
    }
    if (message.name) {
      item.name = message.name;
    }
    if (message.tool_calls) {
      item.tool_calls = message.tool_calls;
    }
    signature.push(item);
  }
  return signature;
}
