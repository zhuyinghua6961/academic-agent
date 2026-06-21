import {newId, utcNow, type JsonObject, type ProviderName, type ProviderRequest, type ProviderResponse} from "@academic-agent/schemas";

import {
  accumulateChatStreamToolCalls,
  chatStreamToolCalls,
  deepseekContextCacheHit,
  iterateSseJsonPayloads,
  normalizeDeepseekUsage,
  normalizeOpenaiUsage,
  openaiCached,
  openaiOutputTextOrNone,
  openaiResponseToolCalls,
} from "./shared.js";
import type {ProviderStreamChunk} from "./types.js";

export async function* iterateOpenaiResponsesStream(
  response: Response,
  options: {
    request: ProviderRequest;
    provider: ProviderName;
    model: string;
  },
): AsyncGenerator<ProviderStreamChunk> {
  const body = response.body;
  if (!body) {
    throw new Error("OpenAI stream response missing body");
  }
  const outputTextChunks: string[] = [];
  let completedPayload: Record<string, unknown> | null = null;
  let lastPayloadId: string | null = null;

  for await (const payload of iterateSseJsonPayloads(body)) {
    if (typeof payload.id === "string") {
      lastPayloadId = payload.id;
    }
    const eventType = payload.type;
    if (eventType === "response.output_text.delta" && typeof payload.delta === "string") {
      const delta = payload.delta;
      outputTextChunks.push(delta);
      yield {type: "content_delta", delta};
      continue;
    }
    if (eventType === "response.output_text.done" && typeof payload.text === "string") {
      outputTextChunks.length = 0;
      outputTextChunks.push(payload.text);
      continue;
    }
    if (
      (eventType === "response.reasoning_summary_text.delta" || eventType === "response.reasoning_text.delta") &&
      typeof payload.delta === "string"
    ) {
      yield {type: "reasoning_delta", reasoning_delta: payload.delta};
      continue;
    }
    if (eventType === "response.completed" && payload.response && typeof payload.response === "object") {
      completedPayload = payload.response as Record<string, unknown>;
    }
  }

  if (!completedPayload) {
    completedPayload = {output_text: outputTextChunks.join("")};
  } else if (outputTextChunks.length > 0 && !("output_text" in completedPayload)) {
    completedPayload = {...completedPayload, output_text: outputTextChunks.join("")};
  }

  const toolCalls = openaiResponseToolCalls(completedPayload);
  const content = openaiOutputTextOrNone(completedPayload);
  const usage = normalizeOpenaiUsage((completedPayload.usage as Record<string, unknown> | undefined) ?? {});
  yield {
    type: "completed",
    response: {
      response_id: newId("provider_resp"),
      request_id: options.request.request_id,
      provider: options.provider,
      model: options.model,
      output: {
        content,
        tool_calls: toolCalls,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : String(completedPayload.status ?? "stop"),
      },
      usage,
      cached: openaiCached((completedPayload.usage as Record<string, unknown> | undefined) ?? {}),
      provider_request_id:
        response.headers.get("x-request-id") ??
        (typeof completedPayload.id === "string" ? completedPayload.id : null) ??
        lastPayloadId,
      created_at: utcNow(),
    } satisfies ProviderResponse,
  };
}

export async function* iterateChatCompletionsStream(
  response: Response,
  options: {
    request: ProviderRequest;
    provider: ProviderName;
    model: string;
  },
): AsyncGenerator<ProviderStreamChunk> {
  const body = response.body;
  if (!body) {
    throw new Error("Chat completions stream response missing body");
  }
  const contentChunks: string[] = [];
  const reasoningChunks: string[] = [];
  const toolBuffers = new Map<number, {call_id: string; name: string; arguments: string}>();
  let usagePayload: Record<string, unknown> = {};
  let finishReason = "stop";
  let providerPayloadId: string | null = null;

  for await (const payload of iterateSseJsonPayloads(body)) {
    if (typeof payload.id === "string") {
      providerPayloadId = payload.id;
    }
    if (payload.usage && typeof payload.usage === "object") {
      usagePayload = payload.usage as Record<string, unknown>;
    }
    const choices = payload.choices;
    if (!Array.isArray(choices)) {
      continue;
    }
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") {
        continue;
      }
      const choiceRecord = choice as Record<string, unknown>;
      if (choiceRecord.finish_reason) {
        finishReason = String(choiceRecord.finish_reason);
      }
      const delta = choiceRecord.delta;
      if (!delta || typeof delta !== "object") {
        continue;
      }
      const deltaRecord = delta as Record<string, unknown>;
      const contentDelta = deltaRecord.content;
      if (typeof contentDelta === "string" && contentDelta) {
        contentChunks.push(contentDelta);
        yield {type: "content_delta", delta: contentDelta};
      }
      const reasoningDelta = deltaRecord.reasoning_content;
      if (typeof reasoningDelta === "string" && reasoningDelta) {
        reasoningChunks.push(reasoningDelta);
        yield {type: "reasoning_delta", reasoning_delta: reasoningDelta};
      }
      accumulateChatStreamToolCalls(toolBuffers, deltaRecord.tool_calls);
      if (deltaRecord.tool_calls) {
        yield {
          type: "tool_call_delta",
          tool_calls: chatStreamToolCalls(toolBuffers) as JsonObject[],
        };
      }
    }
  }

  const toolCalls = chatStreamToolCalls(toolBuffers);
  const output: Record<string, unknown> = {
    content: contentChunks.join("") || null,
    tool_calls: toolCalls,
    finish_reason: toolCalls.length > 0 ? "tool_calls" : finishReason,
  };
  if (reasoningChunks.length > 0) {
    output.reasoning_content = reasoningChunks.join("");
  }
  const usage =
    options.provider === "deepseek"
      ? normalizeDeepseekUsage(usagePayload)
      : normalizeOpenaiUsage(usagePayload);
  const cached =
    options.provider === "deepseek" ? deepseekContextCacheHit(usagePayload) : openaiCached(usagePayload);
  yield {
    type: "completed",
    response: {
      response_id: newId("provider_resp"),
      request_id: options.request.request_id,
      provider: options.provider,
      model: options.model,
      output,
      usage,
      cached,
      provider_request_id: response.headers.get("x-request-id") ?? providerPayloadId,
      created_at: utcNow(),
    } satisfies ProviderResponse,
  };
}
