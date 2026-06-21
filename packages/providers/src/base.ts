import {liveProvidersEnabled} from "@academic-agent/config";
import {stableJsonHash} from "@academic-agent/harness";
import {newId, utcNow, type JsonObject, type ProviderProfileConfig, type ProviderRequest, type ProviderResponse, type ThreadMessage} from "@academic-agent/schemas";

import {
  agentMessagesSignature,
  agentSystemPrompt,
  historySignature,
  systemPrompt,
  userPrompt,
} from "./prompts.js";
import {sanitizeThreadTitle} from "./shared.js";
import type {IdeaDiagnosisProvider, ProviderStreamChunk} from "./types.js";
import {ProviderError, PROMPT_VERSION} from "./types.js";

export class BaseIdeaDiagnosisProvider implements IdeaDiagnosisProvider {
  readonly config: ProviderProfileConfig;
  protected readonly env: Record<string, string>;

  constructor(config: ProviderProfileConfig, env?: Readonly<Record<string, string>>) {
    this.config = config;
    this.env = {...(env ?? process.env as Record<string, string>)};
  }

  buildRequest(idea: string, contextId: string, history: ThreadMessage[] = []): ProviderRequest {
    const messages: JsonObject[] = [
      {
        role: "system",
        content: systemPrompt(),
      },
      {
        role: "user",
        content: userPrompt(idea, history),
        context_id: contextId,
        history: history.map((message) => ({...message})),
      },
    ];
    return {
      request_id: newId("provider_req"),
      provider: this.config.provider,
      model: this.config.model,
      profile: this.config.profile,
      messages,
      prompt_version: PROMPT_VERSION,
      input_hash: stableJsonHash({
        idea,
        provider: this.config.provider,
        model: this.config.model,
        prompt_version: PROMPT_VERSION,
        reasoning_effort: this.config.reasoning_effort,
        reasoning_summary: this.config.reasoning_summary,
        system_prompt: systemPrompt(),
        history: historySignature(history),
      }),
      created_at: utcNow(),
    };
  }

  protected apiKey(): string {
    if (!liveProvidersEnabled(this.env)) {
      throw new ProviderError(
        "Live providers are disabled. Set ACADEMIC_AGENT_ENABLE_LIVE_PROVIDERS=1 to call a live provider.",
      );
    }
    if (!this.config.api_key_env) {
      throw new ProviderError(`Provider ${this.config.provider} requires api_key_env.`);
    }
    const apiKey = this.env[this.config.api_key_env];
    if (!apiKey) {
      throw new ProviderError(`Missing API key env var: ${this.config.api_key_env}`);
    }
    return apiKey;
  }

  protected fallbackThreadTitle(idea: string): string {
    const cleaned = idea.trim().split(/\s+/).join(" ");
    if (!cleaned) {
      return "Untitled Research Idea";
    }
    const words = cleaned.split(" ");
    let title = words.slice(0, 8).join(" ");
    if (title.length > 60) {
      title = "";
      for (const word of words) {
        const candidate = title ? `${title} ${word}` : word;
        if (candidate.length > 60) {
          break;
        }
        title = candidate;
      }
      if (!title) {
        title = cleaned.slice(0, 60);
      }
    }
    return sanitizeThreadTitle(title);
  }

  buildAgentRequest(messages: JsonObject[], tools: JsonObject[] | null = null): ProviderRequest {
    return {
      request_id: newId("provider_req"),
      provider: this.config.provider,
      model: this.config.model,
      profile: this.config.profile,
      messages,
      prompt_version: PROMPT_VERSION,
      input_hash: stableJsonHash({
        provider: this.config.provider,
        model: this.config.model,
        prompt_version: PROMPT_VERSION,
        reasoning_effort: this.config.reasoning_effort,
        reasoning_summary: this.config.reasoning_summary,
        system_prompt: agentSystemPrompt(),
        messages: agentMessagesSignature(messages as Array<Record<string, unknown>>),
        tools: tools ?? [],
      }),
      created_at: utcNow(),
    };
  }

  async generateIdeaDiagnosis(_request: ProviderRequest, _idea: string): Promise<ProviderResponse> {
    throw new Error("Not implemented");
  }

  async generateThreadTitle(_idea: string, _diagnosis: import("@academic-agent/schemas").Diagnosis): Promise<string> {
    throw new Error("Not implemented");
  }

  async generateAgentResponse(
    _request: ProviderRequest,
    _tools: JsonObject[] | null = null,
  ): Promise<ProviderResponse> {
    throw new Error("Not implemented");
  }

  streamAgentResponse(
    _request: ProviderRequest,
    _tools: JsonObject[] | null = null,
  ): AsyncGenerator<ProviderStreamChunk> | null {
    return null;
  }
}
