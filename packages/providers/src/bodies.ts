import {stableJsonHash} from "@academic-agent/harness";
import {
  ThreadMessageSchema,
  type JsonObject,
  type ProviderProfileConfig,
  type ProviderRequest,
  type ThreadMessage,
} from "@academic-agent/schemas";

import {agentSystemPrompt, systemPrompt, userPrompt} from "./prompts.js";
import {
  anthropicMessagesFromChat,
  anthropicToolDefinition,
  openaiResponseToolDefinition,
  openaiResponsesInputFromMessages,
  systemInstructionsFromMessages,
} from "./shared.js";
import {PROMPT_VERSION} from "./types.js";

export function openaiPromptCacheKey(config: ProviderProfileConfig): string {
  return stableJsonHash({
    provider: config.provider,
    profile: config.profile,
    model: config.model,
    prompt_version: PROMPT_VERSION,
    system_prompt: systemPrompt(),
    reasoning_effort: config.reasoning_effort,
    reasoning_summary: config.reasoning_summary,
  });
}

export function openaiAgentPromptCacheKey(config: ProviderProfileConfig, tools: JsonObject[]): string {
  return stableJsonHash({
    provider: config.provider,
    profile: config.profile,
    model: config.model,
    prompt_version: PROMPT_VERSION,
    system_prompt: agentSystemPrompt(),
    tools,
    reasoning_effort: config.reasoning_effort,
    reasoning_summary: config.reasoning_summary,
  });
}

export function openaiResponsesBody(
  config: ProviderProfileConfig,
  idea: string,
  history: ThreadMessage[] = [],
  promptCacheKey?: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    instructions: systemPrompt(),
    input: [{role: "user", content: userPrompt(idea, history)}],
    max_output_tokens: config.max_output_tokens,
  };
  if (promptCacheKey) {
    body.prompt_cache_key = promptCacheKey;
    body.prompt_cache_retention = "24h";
  }
  if (config.temperature != null) {
    body.temperature = config.temperature;
  }
  const reasoning: Record<string, string> = {};
  if (config.reasoning_effort) {
    reasoning.effort = config.reasoning_effort;
  }
  if (config.reasoning_summary) {
    reasoning.summary = config.reasoning_summary;
  }
  if (Object.keys(reasoning).length > 0) {
    body.reasoning = reasoning;
  }
  return body;
}

export function openaiResponsesAgentBody(
  config: ProviderProfileConfig,
  messages: JsonObject[],
  tools: JsonObject[],
  promptCacheKey?: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    instructions: systemInstructionsFromMessages(
      messages as Array<Record<string, unknown>>,
      agentSystemPrompt(),
    ),
    input: openaiResponsesInputFromMessages(messages as Array<Record<string, unknown>>),
    max_output_tokens: config.max_output_tokens,
  };
  if (tools.length > 0) {
    body.tools = tools.map((tool) => openaiResponseToolDefinition(tool as Record<string, unknown>));
    body.tool_choice = "auto";
  }
  if (promptCacheKey) {
    body.prompt_cache_key = promptCacheKey;
    body.prompt_cache_retention = "24h";
  }
  if (config.temperature != null) {
    body.temperature = config.temperature;
  }
  const reasoning: Record<string, string> = {};
  if (config.reasoning_effort) {
    reasoning.effort = config.reasoning_effort;
  }
  if (config.reasoning_summary) {
    reasoning.summary = config.reasoning_summary;
  }
  if (Object.keys(reasoning).length > 0) {
    body.reasoning = reasoning;
  }
  return body;
}

export function anthropicAgentBody(
  config: ProviderProfileConfig,
  messages: JsonObject[],
  tools: JsonObject[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.max_output_tokens,
    system: systemInstructionsFromMessages(
      messages as Array<Record<string, unknown>>,
      agentSystemPrompt(),
    ),
    messages: anthropicMessagesFromChat(messages as Array<Record<string, unknown>>),
  };
  if (tools.length > 0) {
    body.tools = tools.map((tool) => anthropicToolDefinition(tool as Record<string, unknown>));
  }
  if (config.temperature != null) {
    body.temperature = config.temperature;
  }
  return body;
}

export function historyFromProviderRequest(request: ProviderRequest): ThreadMessage[] {
  for (const message of request.messages) {
    const history = message.history;
    if (Array.isArray(history)) {
      return history.map((item) => ThreadMessageSchema.parse(item));
    }
  }
  return [];
}
