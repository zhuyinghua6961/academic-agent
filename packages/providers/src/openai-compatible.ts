import {newId, utcNow, type Diagnosis, type JsonObject, type ProviderRequest, type ProviderResponse} from "@academic-agent/schemas";

import {historyFromProviderRequest} from "./bodies.js";
import {BaseIdeaDiagnosisProvider} from "./base.js";
import {systemPrompt, titleSystemPrompt, titleUserPrompt, userPrompt} from "./prompts.js";
import {
  chatToolCalls,
  diagnosisFromText,
  normalizeOpenaiUsage,
  openaiCached,
  openaiHeaders,
  sanitizeThreadTitle,
} from "./shared.js";
import {iterateChatCompletionsStream} from "./streaming.js";
import {ProviderError, type ProviderStreamChunk} from "./types.js";

export class OpenAICompatibleChatProvider extends BaseIdeaDiagnosisProvider {
  private baseUrl(): string {
    return (this.config.base_url ?? "http://127.0.0.1:8000/v1").replace(/\/$/, "");
  }

  async generateIdeaDiagnosis(request: ProviderRequest, idea: string): Promise<ProviderResponse> {
    const apiKey = this.apiKey();
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
    const response = await fetch(`${this.baseUrl()}/chat/completions`, {
      method: "POST",
      headers: openaiHeaders(apiKey),
      body: JSON.stringify(body),
    });
    if (response.status >= 400) {
      throw new ProviderError(`OpenAI-compatible provider error ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    const message = (choices?.[0]?.message ?? {}) as Record<string, unknown>;
    const diagnosis = diagnosisFromText(String(message.content ?? ""));
    return {
      response_id: newId("provider_resp"),
      request_id: request.request_id,
      provider: this.config.provider,
      model: this.config.model,
      output: {diagnosis},
      usage: (payload.usage as Record<string, unknown> | undefined) ?? {},
      cached: false,
      provider_request_id: response.headers.get("x-request-id") ?? (typeof payload.id === "string" ? payload.id : null),
      created_at: utcNow(),
    };
  }

  async generateThreadTitle(idea: string, diagnosis: Diagnosis): Promise<string> {
    const apiKey = this.apiKey();
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        {role: "system", content: titleSystemPrompt()},
        {role: "user", content: titleUserPrompt(idea, diagnosis)},
      ],
      max_tokens: 40,
    };
    const response = await fetch(`${this.baseUrl()}/chat/completions`, {
      method: "POST",
      headers: openaiHeaders(apiKey),
      body: JSON.stringify(body),
    });
    if (response.status >= 400) {
      throw new ProviderError(
        `OpenAI-compatible title provider error ${response.status}: ${await response.text()}`,
      );
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    const message = (choices?.[0]?.message ?? {}) as Record<string, unknown>;
    return sanitizeThreadTitle(String(message.content ?? ""));
  }

  async generateAgentResponse(
    request: ProviderRequest,
    tools: JsonObject[] | null = null,
  ): Promise<ProviderResponse> {
    const apiKey = this.apiKey();
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
    const response = await fetch(`${this.baseUrl()}/chat/completions`, {
      method: "POST",
      headers: openaiHeaders(apiKey),
      body: JSON.stringify(body),
    });
    if (response.status >= 400) {
      throw new ProviderError(`OpenAI-compatible agent error ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const choice = ((payload.choices as Array<Record<string, unknown>> | undefined)?.[0] ?? {}) as Record<string, unknown>;
    const message = (choice.message ?? {}) as Record<string, unknown>;
    const toolCalls = chatToolCalls(message);
    const usage = normalizeOpenaiUsage((payload.usage as Record<string, unknown> | undefined) ?? {});
    return {
      response_id: newId("provider_resp"),
      request_id: request.request_id,
      provider: this.config.provider,
      model: this.config.model,
      output: {
        content: message.content ?? null,
        tool_calls: toolCalls,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : String(choice.finish_reason ?? "stop"),
      },
      usage,
      cached: openaiCached((payload.usage as Record<string, unknown> | undefined) ?? {}),
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
    return this.streamChatCompletions(body, request);
  }

  private async *streamChatCompletions(
    body: Record<string, unknown>,
    request: ProviderRequest,
  ): AsyncGenerator<ProviderStreamChunk> {
    const apiKey = this.apiKey();
    const response = await fetch(`${this.baseUrl()}/chat/completions`, {
      method: "POST",
      headers: openaiHeaders(apiKey),
      body: JSON.stringify(body),
    });
    if (response.status >= 400) {
      throw new ProviderError(`OpenAI-compatible provider error ${response.status}: ${await response.text()}`);
    }
    yield* iterateChatCompletionsStream(response, {
      request,
      provider: this.config.provider,
      model: this.config.model,
    });
  }
}
