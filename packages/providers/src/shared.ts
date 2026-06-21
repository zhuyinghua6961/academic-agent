import {DiagnosisSchema, ThreadMessageSchema, type Diagnosis, type ProviderRequest, type ThreadMessage} from "@academic-agent/schemas";

import {ProviderError} from "./types.js";

export function historyFromRequest(request: ProviderRequest): ThreadMessage[] {
  for (const message of request.messages) {
    const history = message.history;
    if (Array.isArray(history)) {
      return history.map((item) => ThreadMessageSchema.parse(item));
    }
  }
  return [];
}

export function diagnosisFromText(text: string): Diagnosis {
  let cleaned = stripXmlToolCalls(text).trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^`+/, "").trim();
    if (cleaned.startsWith("json")) {
      cleaned = cleaned.slice(4).trim();
    }
  }
  try {
    const payload = JSON.parse(cleaned) as unknown;
    return DiagnosisSchema.parse(payload);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProviderError(`Provider did not return valid diagnosis JSON: ${text.slice(0, 500)} (${detail})`);
  }
}

export function stripXmlToolCalls(text: string): string {
  let result = text;
  result = result.replace(
    /<\s*[｜|]?\s*tool[_\s]*calls?\s*[｜|]?\s*>.*?<\/\s*[｜|]?\s*tool[_\s]*calls?\s*[｜|]?\s*>/gis,
    "",
  );
  result = result.replace(/<\s*[｜|]?\s*(?:invoke|parameter)\s+[^>]*\/\s*>/gi, "");
  result = result.replace(
    /<\s*[｜|]?\s*(?:invoke|parameter)\s+[^>]*>.*?<\/\s*[｜|]?\s*(?:invoke|parameter)\s*>/gis,
    "",
  );
  return result;
}

export function sanitizeThreadTitle(text: string): string {
  let title = text.trim().replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, "");
  title = title.split(/\s+/).join(" ");
  title = title.replace(/^[#*\-\d.\s]+/, "").trim();
  if (!title) {
    return "Untitled Research Idea";
  }
  if (title.length > 60) {
    title = `${title.slice(0, 57).trimEnd()}...`;
  }
  return title;
}

export function chatToolCalls(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const toolCalls: Array<Record<string, unknown>> = [];
  const rawToolCalls = message.tool_calls;
  if (!Array.isArray(rawToolCalls)) {
    return toolCalls;
  }
  for (const tc of rawToolCalls) {
    if (!tc || typeof tc !== "object") {
      continue;
    }
    const record = tc as Record<string, unknown>;
    const func = (record.function ?? {}) as Record<string, unknown>;
    let args: Record<string, unknown> = {};
    try {
      const rawArgs = func.arguments ?? "{}";
      args = typeof rawArgs === "string" ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      args = {};
    }
    toolCalls.push({
      call_id: String(record.id ?? ""),
      name: String(func.name ?? ""),
      arguments: args,
    });
  }
  return toolCalls;
}

export function normalizeOpenaiUsage(usage: Record<string, unknown>): Record<string, unknown> {
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const details =
    (usage.input_tokens_details as Record<string, unknown> | undefined) ??
    (usage.prompt_tokens_details as Record<string, unknown> | undefined) ??
    (usage.input_tokens_detail as Record<string, unknown> | undefined) ??
    {};
  const cachedTokens =
    details.cached_tokens ??
    usage.input_cached_tokens ??
    usage.prompt_cached_tokens ??
    usage.cached_tokens ??
    0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: usage.total_tokens ?? Number(inputTokens) + Number(outputTokens),
    cache_read_tokens: cachedTokens,
    input_tokens_details: details,
  };
}

export function openaiCached(usage: Record<string, unknown>): boolean {
  const details =
    (usage.input_tokens_details as Record<string, unknown> | undefined) ??
    (usage.prompt_tokens_details as Record<string, unknown> | undefined) ??
    (usage.input_tokens_detail as Record<string, unknown> | undefined) ??
    {};
  const cachedTokens =
    details.cached_tokens ??
    usage.input_cached_tokens ??
    usage.prompt_cached_tokens ??
    usage.cached_tokens ??
    0;
  return Boolean(cachedTokens);
}

export function normalizeAnthropicUsage(usage: Record<string, unknown>): Record<string, unknown> {
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0,
  };
}

export function normalizeDeepseekUsage(usage: Record<string, unknown>): Record<string, unknown> {
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? 0;
  return {
    input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
    cache_read_tokens: hit,
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: miss,
  };
}

export function deepseekContextCacheHit(usage: Record<string, unknown>): boolean {
  return Boolean(usage.prompt_cache_hit_tokens ?? 0);
}

export function applyDeepseekReasoning(
  body: Record<string, unknown>,
  config: {reasoning_effort?: string | null; reasoning_summary?: string | null},
): void {
  if (!config.reasoning_effort) {
    return;
  }
  const reasoning: Record<string, string> = {effort: config.reasoning_effort};
  if (config.reasoning_summary) {
    reasoning.summary = config.reasoning_summary;
  }
  body.reasoning = reasoning;
}

export function openaiHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "user-agent": "academic-agent/0.1.0",
  };
}

export function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "user-agent": "academic-agent/0.1.0",
  };
}

export function unsupportedParameter(text: string): string | null {
  const match = /Unsupported parameter: ([A-Za-z0-9_.-]+)/.exec(text);
  return match?.[1] ?? null;
}

export function removeParameter(body: Record<string, unknown>, parameter: string): boolean {
  const parts = parameter.split(".");
  let target: unknown = body;
  for (const part of parts.slice(0, -1)) {
    if (!target || typeof target !== "object" || !(part in (target as Record<string, unknown>))) {
      return false;
    }
    target = (target as Record<string, unknown>)[part];
  }
  const last = parts[parts.length - 1];
  if (target && typeof target === "object" && last && last in (target as Record<string, unknown>)) {
    delete (target as Record<string, unknown>)[last];
    return true;
  }
  return false;
}

export async function postWithUnsupportedParameterRetries(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Response> {
  const current = structuredClone(body);
  const removed = new Set<string>();
  let response: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(current),
    });
    if (response.status !== 400) {
      return response;
    }
    const text = await response.text();
    const parameter = unsupportedParameter(text);
    if (!parameter || removed.has(parameter) || !removeParameter(current, parameter)) {
      return new Response(text, {status: response.status, headers: response.headers});
    }
    removed.add(parameter);
  }
  return response ?? new Response("", {status: 500});
}

export function openaiOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }
  const chunks: string[] = [];
  const output = payload.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const content = (item as Record<string, unknown>).content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const record = block as Record<string, unknown>;
        if ((record.type === "output_text" || record.type === "text") && typeof record.text === "string") {
          chunks.push(record.text);
        }
      }
    }
  }
  if (chunks.length === 0) {
    throw new ProviderError("OpenAI response did not contain output text.");
  }
  return chunks.join("\n");
}

export function openaiOutputTextOrNone(payload: Record<string, unknown>): string | null {
  try {
    return openaiOutputText(payload);
  } catch {
    return null;
  }
}

export function anthropicOutputText(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (!Array.isArray(content)) {
    throw new ProviderError("Anthropic response did not contain text content.");
  }
  const chunks = content
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object" && (item as Record<string, unknown>).type === "text"),
    )
    .map((item) => String(item.text ?? ""))
    .filter((text) => text.length > 0);
  if (chunks.length === 0) {
    throw new ProviderError("Anthropic response did not contain text content.");
  }
  return chunks.join("\n");
}

export function anthropicOutputTextOrNone(payload: Record<string, unknown>): string | null {
  const content = payload.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const chunks = content
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object" && (item as Record<string, unknown>).type === "text"),
    )
    .map((item) => String(item.text ?? ""))
    .filter((text) => text.length > 0);
  return chunks.length > 0 ? chunks.join("\n") : null;
}

export function openaiResponseToolCalls(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const calls: Array<Record<string, unknown>> = [];
  const output = payload.output;
  if (!Array.isArray(output)) {
    return calls;
  }
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.type !== "function_call") {
      continue;
    }
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(String(record.arguments ?? "{}")) as Record<string, unknown>;
    } catch {
      args = {};
    }
    calls.push({
      call_id: record.call_id ?? record.id ?? "",
      name: record.name ?? "",
      arguments: args,
    });
  }
  return calls;
}

export function systemInstructionsFromMessages(messages: Array<Record<string, unknown>>, fallback: string): string {
  const chunks = messages
    .filter((message) => message.role === "system" && message.content)
    .map((message) => String(message.content));
  return chunks.length > 0 ? chunks.join("\n\n") : fallback;
}

export function openaiResponsesInputFromMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const role = message.role;
    if (role === "system") {
      continue;
    }
    if (role === "tool") {
      const callId = String(message.tool_call_id ?? "");
      if (callId) {
        items.push({
          type: "function_call_output",
          call_id: callId,
          output: String(message.content ?? ""),
        });
      }
      continue;
    }
    if (role === "assistant") {
      const content = message.content;
      if (content) {
        items.push({role: "assistant", content: String(content)});
      }
      const toolCalls = message.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const toolCall of toolCalls) {
          if (!toolCall || typeof toolCall !== "object") {
            continue;
          }
          const record = toolCall as Record<string, unknown>;
          const func = (record.function ?? {}) as Record<string, unknown>;
          let args = func.arguments ?? "{}";
          if (typeof args !== "string") {
            args = JSON.stringify(args);
          }
          items.push({
            type: "function_call",
            call_id: record.id ?? "",
            name: func.name ?? "",
            arguments: args,
          });
        }
      }
      continue;
    }
    if (role === "user") {
      items.push({role: "user", content: String(message.content ?? "")});
    }
  }
  return items;
}

export function openaiResponseToolDefinition(tool: Record<string, unknown>): Record<string, unknown> {
  const func = (tool.function ?? {}) as Record<string, unknown>;
  if (tool.type === "function" && Object.keys(func).length > 0) {
    return {
      type: "function",
      name: func.name ?? "",
      description: func.description ?? "",
      parameters: func.parameters ?? {type: "object", properties: {}},
    };
  }
  return tool;
}

export function anthropicToolDefinition(tool: Record<string, unknown>): Record<string, unknown> {
  const func = (tool.function ?? {}) as Record<string, unknown>;
  if (tool.type === "function" && Object.keys(func).length > 0) {
    return {
      name: func.name ?? "",
      description: func.description ?? "",
      input_schema: func.parameters ?? {type: "object", properties: {}},
    };
  }
  return tool;
}

export function anthropicMessagesFromChat(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const role = message.role;
    if (role === "system") {
      continue;
    }
    if (role === "tool") {
      const callId = String(message.tool_call_id ?? "");
      if (callId) {
        converted.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: callId,
              content: String(message.content ?? ""),
            },
          ],
        });
      }
      continue;
    }
    if (role === "assistant") {
      const contentBlocks: Array<Record<string, unknown>> = [];
      const content = message.content;
      if (content) {
        contentBlocks.push({type: "text", text: String(content)});
      }
      const toolCalls = message.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const toolCall of toolCalls) {
          if (!toolCall || typeof toolCall !== "object") {
            continue;
          }
          const record = toolCall as Record<string, unknown>;
          const func = (record.function ?? {}) as Record<string, unknown>;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(String(func.arguments ?? "{}")) as Record<string, unknown>;
          } catch {
            args = {};
          }
          contentBlocks.push({
            type: "tool_use",
            id: record.id ?? "",
            name: func.name ?? "",
            input: args,
          });
        }
      }
      if (contentBlocks.length > 0) {
        converted.push({role: "assistant", content: contentBlocks});
      }
      continue;
    }
    if (role === "user") {
      converted.push({role: "user", content: String(message.content ?? "")});
    }
  }
  return converted;
}

export function anthropicToolCalls(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const calls: Array<Record<string, unknown>> = [];
  const content = payload.content;
  if (!Array.isArray(content)) {
    return calls;
  }
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.type !== "tool_use") {
      continue;
    }
    const args = record.input;
    calls.push({
      call_id: record.id ?? "",
      name: record.name ?? "",
      arguments: args && typeof args === "object" ? (args as Record<string, unknown>) : {},
    });
  }
  return calls;
}

export async function* iterateSseJsonPayloads(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, {stream: true});
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data && data !== "[DONE]") {
            try {
              const payload = JSON.parse(data) as unknown;
              if (payload && typeof payload === "object") {
                yield payload as Record<string, unknown>;
              }
            } catch {
              // ignore malformed SSE chunks
            }
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function accumulateChatStreamToolCalls(
  toolBuffers: Map<number, {call_id: string; name: string; arguments: string}>,
  toolCallDeltas: unknown,
): void {
  if (!Array.isArray(toolCallDeltas)) {
    return;
  }
  for (const delta of toolCallDeltas) {
    if (!delta || typeof delta !== "object") {
      continue;
    }
    const record = delta as Record<string, unknown>;
    const indexValue = record.index;
    const index = typeof indexValue === "number" ? indexValue : toolBuffers.size;
    const buffer = toolBuffers.get(index) ?? {call_id: "", name: "", arguments: ""};
    if (typeof record.id === "string" && record.id) {
      buffer.call_id = record.id;
    }
    const func = record.function;
    if (func && typeof func === "object") {
      const functionRecord = func as Record<string, unknown>;
      if (typeof functionRecord.name === "string" && functionRecord.name) {
        buffer.name += functionRecord.name;
      }
      if (typeof functionRecord.arguments === "string") {
        buffer.arguments += functionRecord.arguments;
      }
    }
    toolBuffers.set(index, buffer);
  }
}

export function chatStreamToolCalls(
  toolBuffers: Map<number, {call_id: string; name: string; arguments: string}>,
): Array<Record<string, unknown>> {
  const calls: Array<Record<string, unknown>> = [];
  for (const index of [...toolBuffers.keys()].sort((a, b) => a - b)) {
    const buffer = toolBuffers.get(index);
    if (!buffer || !buffer.name) {
      continue;
    }
    let argumentsValue: Record<string, unknown> = {};
    try {
      argumentsValue = JSON.parse(buffer.arguments || "{}") as Record<string, unknown>;
    } catch {
      argumentsValue = {};
    }
    calls.push({
      call_id: buffer.call_id || `call_${index}`,
      name: buffer.name,
      arguments: argumentsValue,
    });
  }
  return calls;
}

export function payloadFromSse(text: string): Record<string, unknown> | null {
  let completed: Record<string, unknown> | null = null;
  let lastPayload: Record<string, unknown> | null = null;
  const outputTextChunks: string[] = [];
  for (const block of text.split("\n\n")) {
    const dataLines = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) {
      continue;
    }
    const data = dataLines.join("\n");
    if (data === "[DONE]") {
      continue;
    }
    try {
      const payload = JSON.parse(data) as Record<string, unknown>;
      lastPayload = payload;
      if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") {
        outputTextChunks.push(payload.delta);
      }
      if (payload.type === "response.output_text.done" && typeof payload.text === "string") {
        outputTextChunks.length = 0;
        outputTextChunks.push(payload.text);
      }
      if (payload.type === "response.completed" && payload.response && typeof payload.response === "object") {
        completed = payload.response as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  if (completed && outputTextChunks.length > 0 && !("output_text" in completed)) {
    completed.output_text = outputTextChunks.join("");
  }
  if (!completed && outputTextChunks.length > 0) {
    return {output_text: outputTextChunks.join("")};
  }
  return completed ?? lastPayload;
}

export async function openaiPayloadFromResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const payload = JSON.parse(text) as unknown;
    if (!payload || typeof payload !== "object") {
      throw new ProviderError(`OpenAI provider returned non-object JSON: ${text.slice(0, 500)}`);
    }
    return payload as Record<string, unknown>;
  } catch {
    const payload = payloadFromSse(text);
    if (payload) {
      return payload;
    }
    throw new ProviderError(`OpenAI provider returned non-JSON response: ${text.slice(0, 500)}`);
  }
}
