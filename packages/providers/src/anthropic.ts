import Anthropic from "@anthropic-ai/sdk";

import {newId, utcNow, type Diagnosis, type JsonObject, type ProviderRequest, type ProviderResponse} from "@academic-agent/schemas";

import {anthropicAgentBody, historyFromProviderRequest} from "./bodies.js";
import {BaseIdeaDiagnosisProvider} from "./base.js";
import {systemPrompt, titleSystemPrompt, titleUserPrompt, userPrompt} from "./prompts.js";
import {
  anthropicOutputText,
  anthropicOutputTextOrNone,
  anthropicToolCalls,
  diagnosisFromText,
  normalizeAnthropicUsage,
  sanitizeThreadTitle,
} from "./shared.js";
import {ProviderError} from "./types.js";

export class AnthropicMessagesProvider extends BaseIdeaDiagnosisProvider {
  private client(): Anthropic {
    const apiKey = this.apiKey();
    const baseURL = (this.config.base_url ?? "https://api.anthropic.com").replace(/\/$/, "");
    return new Anthropic({apiKey, baseURL});
  }

  async generateIdeaDiagnosis(request: ProviderRequest, idea: string): Promise<ProviderResponse> {
    const client = this.client();
    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.max_output_tokens,
      system: systemPrompt(),
      messages: [{role: "user", content: userPrompt(idea, historyFromProviderRequest(request))}],
    };
    if (this.config.temperature != null) {
      body.temperature = this.config.temperature;
    }
    let payload: Record<string, unknown>;
    try {
      payload = (await client.messages.create(body as unknown as Anthropic.MessageCreateParams)) as unknown as Record<string, unknown>;
    } catch (error) {
      throw new ProviderError(`Anthropic provider error: ${error instanceof Error ? error.message : String(error)}`);
    }
    const diagnosis = diagnosisFromText(anthropicOutputText(payload));
    const usage = (payload.usage as Record<string, unknown> | undefined) ?? {};
    return {
      response_id: newId("provider_resp"),
      request_id: request.request_id,
      provider: this.config.provider,
      model: this.config.model,
      output: {diagnosis},
      usage: normalizeAnthropicUsage(usage),
      cached: false,
      provider_request_id: typeof payload.id === "string" ? payload.id : null,
      created_at: utcNow(),
    };
  }

  async generateThreadTitle(idea: string, diagnosis: Diagnosis): Promise<string> {
    const client = this.client();
    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: 40,
      system: titleSystemPrompt(),
      messages: [{role: "user", content: titleUserPrompt(idea, diagnosis)}],
    };
    let payload: Record<string, unknown>;
    try {
      payload = (await client.messages.create(body as unknown as Anthropic.MessageCreateParams)) as unknown as Record<string, unknown>;
    } catch (error) {
      throw new ProviderError(`Anthropic title provider error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return sanitizeThreadTitle(anthropicOutputText(payload));
  }

  async generateAgentResponse(
    request: ProviderRequest,
    tools: JsonObject[] | null = null,
  ): Promise<ProviderResponse> {
    const client = this.client();
    const body = anthropicAgentBody(this.config, request.messages, tools ?? []);
    let payload: Record<string, unknown>;
    try {
      payload = (await client.messages.create(body as unknown as Anthropic.MessageCreateParams)) as unknown as Record<string, unknown>;
    } catch (error) {
      throw new ProviderError(`Anthropic agent error: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = anthropicOutputTextOrNone(payload);
    const toolCalls = anthropicToolCalls(payload);
    const usage = (payload.usage as Record<string, unknown> | undefined) ?? {};
    return {
      response_id: newId("provider_resp"),
      request_id: request.request_id,
      provider: this.config.provider,
      model: this.config.model,
      output: {
        content: text,
        tool_calls: toolCalls,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : String(payload.stop_reason ?? "stop"),
      },
      usage: normalizeAnthropicUsage(usage),
      cached: Boolean(usage.cache_read_input_tokens ?? 0),
      provider_request_id: typeof payload.id === "string" ? payload.id : null,
      created_at: utcNow(),
    };
  }
}
