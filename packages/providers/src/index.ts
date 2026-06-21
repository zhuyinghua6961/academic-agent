import type {ProviderProfileConfig} from "@academic-agent/schemas";

import {AnthropicMessagesProvider} from "./anthropic.js";
import {openaiResponsesAgentBody, openaiResponsesBody, anthropicAgentBody} from "./bodies.js";
import {BaseIdeaDiagnosisProvider} from "./base.js";
import {DeepSeekChatProvider} from "./deepseek.js";
import {OpenAICompatibleChatProvider} from "./openai-compatible.js";
import {OpenAIResponsesProvider} from "./openai.js";
import {RecordedProvider, recordedProviderEnabled} from "./recorded.js";
import {ProviderError, PROMPT_VERSION, type IdeaDiagnosisProvider} from "./types.js";

export {PROMPT_VERSION, ProviderError};
export type {IdeaDiagnosisProvider, ProviderStreamChunk} from "./types.js";
export {BaseIdeaDiagnosisProvider} from "./base.js";
export {RecordedProvider, recordedProviderEnabled} from "./recorded.js";
export {OpenAIResponsesProvider} from "./openai.js";
export {AnthropicMessagesProvider} from "./anthropic.js";
export {OpenAICompatibleChatProvider} from "./openai-compatible.js";
export {DeepSeekChatProvider} from "./deepseek.js";
export {openaiResponsesBody, openaiResponsesAgentBody, anthropicAgentBody} from "./bodies.js";
export {agentSystemPrompt} from "./prompts.js";
export * from "./prompts/index.js";
export {diagnosisFromText} from "./shared.js";
export {verifyLlmConnection, normalizeVerifyError} from "./verify-connection.js";
export type {VerifyConnectionResult} from "./verify-connection.js";

export function createIdeaDiagnosisProvider(
  config: ProviderProfileConfig,
  env?: Readonly<Record<string, string>>,
): IdeaDiagnosisProvider {
  if (recordedProviderEnabled(env)) {
    return new RecordedProvider(config, env);
  }
  switch (config.provider) {
    case "openai":
      return new OpenAIResponsesProvider(config, env);
    case "anthropic":
      return new AnthropicMessagesProvider(config, env);
    case "openai_compatible":
      return new OpenAICompatibleChatProvider(config, env);
    case "deepseek":
      return new DeepSeekChatProvider(config, env);
    default:
      throw new ProviderError(`Unsupported provider: ${config.provider}`);
  }
}
