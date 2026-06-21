import {newId, utcNow, type Diagnosis, type JsonObject, type ProviderRequest, type ProviderResponse} from "@academic-agent/schemas";

import {
  historyFromProviderRequest,
  openaiAgentPromptCacheKey,
  openaiPromptCacheKey,
  openaiResponsesAgentBody,
  openaiResponsesBody,
} from "./bodies.js";
import {BaseIdeaDiagnosisProvider} from "./base.js";
import {titleSystemPrompt, titleUserPrompt} from "./prompts.js";
import {
  diagnosisFromText,
  openaiCached,
  openaiHeaders,
  openaiOutputText,
  openaiOutputTextOrNone,
  openaiPayloadFromResponse,
  openaiResponseToolCalls,
  normalizeOpenaiUsage,
  postWithUnsupportedParameterRetries,
  sanitizeThreadTitle,
} from "./shared.js";
import {iterateOpenaiResponsesStream} from "./streaming.js";
import {ProviderError, type ProviderStreamChunk} from "./types.js";

export class OpenAIResponsesProvider extends BaseIdeaDiagnosisProvider {
  async generateIdeaDiagnosis(request: ProviderRequest, idea: string): Promise<ProviderResponse> {
    const apiKey = this.apiKey();
    const baseUrl = (this.config.base_url ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const body = openaiResponsesBody(
      this.config,
      idea,
      historyFromProviderRequest(request),
      openaiPromptCacheKey(this.config),
    );
    const response = await postWithUnsupportedParameterRetries(
      `${baseUrl}/responses`,
      openaiHeaders(apiKey),
      body,
    );
    if (response.status >= 400) {
      throw new ProviderError(`OpenAI provider error ${response.status}: ${await response.text()}`);
    }
    const payload = await openaiPayloadFromResponse(response);
    const diagnosis = diagnosisFromText(openaiOutputText(payload));
    return {
      response_id: newId("provider_resp"),
      request_id: request.request_id,
      provider: this.config.provider,
      model: this.config.model,
      output: {diagnosis},
      usage: normalizeOpenaiUsage((payload.usage as Record<string, unknown> | undefined) ?? {}),
      cached: openaiCached((payload.usage as Record<string, unknown> | undefined) ?? {}),
      provider_request_id: response.headers.get("x-request-id") ?? (typeof payload.id === "string" ? payload.id : null),
      created_at: utcNow(),
    };
  }

  async generateThreadTitle(idea: string, diagnosis: Diagnosis): Promise<string> {
    const apiKey = this.apiKey();
    const baseUrl = (this.config.base_url ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const body = {
      model: this.config.model,
      instructions: titleSystemPrompt(),
      input: [{role: "user", content: titleUserPrompt(idea, diagnosis)}],
      max_output_tokens: 40,
    };
    const response = await postWithUnsupportedParameterRetries(
      `${baseUrl}/responses`,
      openaiHeaders(apiKey),
      body,
    );
    if (response.status >= 400) {
      throw new ProviderError(`OpenAI title provider error ${response.status}: ${await response.text()}`);
    }
    const payload = await openaiPayloadFromResponse(response);
    return sanitizeThreadTitle(openaiOutputText(payload));
  }

  async generateAgentResponse(
    request: ProviderRequest,
    tools: JsonObject[] | null = null,
  ): Promise<ProviderResponse> {
    const apiKey = this.apiKey();
    const baseUrl = (this.config.base_url ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const resolvedTools = tools ?? [];
    const body = openaiResponsesAgentBody(
      this.config,
      request.messages,
      resolvedTools,
      openaiAgentPromptCacheKey(this.config, resolvedTools),
    );
    const response = await postWithUnsupportedParameterRetries(
      `${baseUrl}/responses`,
      openaiHeaders(apiKey),
      body,
    );
    if (response.status >= 400) {
      throw new ProviderError(`OpenAI agent error ${response.status}: ${await response.text()}`);
    }
    const payload = await openaiPayloadFromResponse(response);
    const toolCalls = openaiResponseToolCalls(payload);
    const content = openaiOutputTextOrNone(payload);
    return {
      response_id: newId("provider_resp"),
      request_id: request.request_id,
      provider: this.config.provider,
      model: this.config.model,
      output: {
        content,
        tool_calls: toolCalls,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
      usage: normalizeOpenaiUsage((payload.usage as Record<string, unknown> | undefined) ?? {}),
      cached: openaiCached((payload.usage as Record<string, unknown> | undefined) ?? {}),
      provider_request_id: response.headers.get("x-request-id") ?? (typeof payload.id === "string" ? payload.id : null),
      created_at: utcNow(),
    };
  }

  streamAgentResponse(
    request: ProviderRequest,
    tools: JsonObject[] | null = null,
  ): AsyncGenerator<ProviderStreamChunk> {
    const apiKey = this.apiKey();
    const baseUrl = (this.config.base_url ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const resolvedTools = tools ?? [];
    const body = {
      ...openaiResponsesAgentBody(
        this.config,
        request.messages,
        resolvedTools,
        openaiAgentPromptCacheKey(this.config, resolvedTools),
      ),
      stream: true,
    };
    return this.streamOpenaiResponses(`${baseUrl}/responses`, apiKey, body, request);
  }

  private async *streamOpenaiResponses(
    url: string,
    apiKey: string,
    body: Record<string, unknown>,
    request: ProviderRequest,
  ): AsyncGenerator<ProviderStreamChunk> {
    const response = await fetch(url, {
      method: "POST",
      headers: openaiHeaders(apiKey),
      body: JSON.stringify(body),
    });
    if (response.status >= 400) {
      throw new ProviderError(`OpenAI provider error ${response.status}: ${await response.text()}`);
    }
    yield* iterateOpenaiResponsesStream(response, {
      request,
      provider: this.config.provider,
      model: this.config.model,
    });
  }
}
