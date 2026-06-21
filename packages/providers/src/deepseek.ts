import {newId, utcNow, type Diagnosis, type JsonObject, type ProviderRequest, type ProviderResponse} from "@academic-agent/schemas";

import {historyFromProviderRequest} from "./bodies.js";
import {BaseIdeaDiagnosisProvider} from "./base.js";
import {systemPrompt, titleSystemPrompt, titleUserPrompt, userPrompt} from "./prompts.js";
import {
  applyDeepseekReasoning,
  chatToolCalls,
  deepseekContextCacheHit,
  diagnosisFromText,
  normalizeDeepseekUsage,
  openaiHeaders,
  sanitizeThreadTitle,
} from "./shared.js";
import {iterateChatCompletionsStream} from "./streaming.js";
import {ProviderError, type ProviderStreamChunk} from "./types.js";

export class DeepSeekChatProvider extends BaseIdeaDiagnosisProvider {
  private baseUrl(): string {
    return (this.config.base_url ?? "https://api.deepseek.com").replace(/\/$/, "");
  }

  private async chatPost(body: Record<string, unknown>, timeoutMs = 60_000): Promise<Response> {
    const apiKey = this.apiKey();
    const baseUrl = this.baseUrl();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: openaiHeaders(apiKey),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async generateIdeaDiagnosis(request: ProviderRequest, idea: string): Promise<ProviderResponse> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        {role: "system", content: systemPrompt()},
        {role: "user", content: userPrompt(idea, historyFromProviderRequest(request))},
      ],
      max_tokens: this.config.max_output_tokens,
    };
    if (this.config.temperature != null) {
      body.temperature = this.config.temperature;
    }
    applyDeepseekReasoning(body, this.config);
    const response = await this.chatPost(body);
    if (response.status >= 400) {
      throw new ProviderError(`DeepSeek provider error ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    const message = (choices?.[0]?.message ?? {}) as Record<string, unknown>;
    const diagnosis = diagnosisFromText(String(message.content ?? ""));
    const usage = normalizeDeepseekUsage((payload.usage as Record<string, unknown> | undefined) ?? {});
    return {
      response_id: newId("provider_resp"),
      request_id: request.request_id,
      provider: this.config.provider,
      model: this.config.model,
      output: {diagnosis},
      usage,
      cached: deepseekContextCacheHit((payload.usage as Record<string, unknown> | undefined) ?? {}),
      provider_request_id: response.headers.get("x-request-id") ?? (typeof payload.id === "string" ? payload.id : null),
      created_at: utcNow(),
    };
  }

  async generateAgentResponse(
    request: ProviderRequest,
    tools: JsonObject[] | null = null,
  ): Promise<ProviderResponse> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: request.messages,
      max_tokens: this.config.max_output_tokens,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    if (this.config.temperature != null) {
      body.temperature = this.config.temperature;
    }
    applyDeepseekReasoning(body, this.config);
    const response = await this.chatPost(body);
    if (response.status >= 400) {
      throw new ProviderError(`DeepSeek agent error ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const choice = ((payload.choices as Array<Record<string, unknown>> | undefined)?.[0] ?? {}) as Record<string, unknown>;
    const message = (choice.message ?? {}) as Record<string, unknown>;
    const toolCalls = chatToolCalls(message);
    const usage = normalizeDeepseekUsage((payload.usage as Record<string, unknown> | undefined) ?? {});
    return {
      response_id: newId("provider_resp"),
      request_id: request.request_id,
      provider: this.config.provider,
      model: this.config.model,
      output: {
        content: message.content ?? null,
        reasoning_content: message.reasoning_content ?? null,
        tool_calls: toolCalls,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : String(choice.finish_reason ?? "stop"),
      },
      usage,
      cached: deepseekContextCacheHit((payload.usage as Record<string, unknown> | undefined) ?? {}),
      provider_request_id: response.headers.get("x-request-id") ?? (typeof payload.id === "string" ? payload.id : null),
      created_at: utcNow(),
    };
  }

  streamAgentResponse(
    request: ProviderRequest,
    tools: JsonObject[] | null = null,
  ): AsyncGenerator<ProviderStreamChunk> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: request.messages,
      max_tokens: this.config.max_output_tokens,
      stream: true,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    if (this.config.temperature != null) {
      body.temperature = this.config.temperature;
    }
    applyDeepseekReasoning(body, this.config);
    return this.streamChatCompletions(body, request);
  }

  async generateThreadTitle(idea: string, diagnosis: Diagnosis): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        {role: "system", content: titleSystemPrompt()},
        {role: "user", content: titleUserPrompt(idea, diagnosis)},
      ],
      max_tokens: 40,
    };
    const response = await this.chatPost(body, 30_000);
    if (response.status >= 400) {
      throw new ProviderError(`DeepSeek title provider error ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    const message = (choices?.[0]?.message ?? {}) as Record<string, unknown>;
    return sanitizeThreadTitle(String(message.content ?? ""));
  }

  private async *streamChatCompletions(
    body: Record<string, unknown>,
    request: ProviderRequest,
  ): AsyncGenerator<ProviderStreamChunk> {
    const apiKey = this.apiKey();
    const baseUrl = this.baseUrl();
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: openaiHeaders(apiKey),
      body: JSON.stringify(body),
    });
    if (response.status >= 400) {
      throw new ProviderError(`DeepSeek agent error ${response.status}: ${await response.text()}`);
    }
    yield* iterateChatCompletionsStream(response, {
      request,
      provider: this.config.provider,
      model: this.config.model,
    });
  }
}
