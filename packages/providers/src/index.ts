import type {ProviderProfileConfig} from "@academic-agent/schemas";

import {AnthropicMessagesProvider} from "./anthropic.js";
import {openaiResponsesAgentBody, openaiResponsesBody, anthropicAgentBody} from "./bodies.js";
import {BaseIdeaDiagnosisProvider} from "./base.js";
import {DeepSeekChatProvider} from "./deepseek.js";
import {DeterministicMockProvider} from "./mock.js";
import {OpenAICompatibleChatProvider} from "./openai-compatible.js";
import {OpenAIResponsesProvider} from "./openai.js";
import {ProviderError, PROMPT_VERSION, type IdeaDiagnosisProvider} from "./types.js";

export {PROMPT_VERSION, ProviderError};
export type {IdeaDiagnosisProvider, ProviderStreamChunk} from "./types.js";
export {BaseIdeaDiagnosisProvider} from "./base.js";
export {DeterministicMockProvider} from "./mock.js";
export {OpenAIResponsesProvider} from "./openai.js";
export {AnthropicMessagesProvider} from "./anthropic.js";
export {OpenAICompatibleChatProvider} from "./openai-compatible.js";
export {DeepSeekChatProvider} from "./deepseek.js";
export {openaiResponsesBody, openaiResponsesAgentBody, anthropicAgentBody} from "./bodies.js";
export {agentSystemPrompt} from "./prompts.js";
export {diagnosisFromText} from "./shared.js";
export {verifyLlmConnection, normalizeVerifyError} from "./verify-connection.js";
export type {VerifyConnectionResult} from "./verify-connection.js";

export function createIdeaDiagnosisProvider(
  config: ProviderProfileConfig,
  env?: Readonly<Record<string, string>>,
): IdeaDiagnosisProvider {
  switch (config.provider) {
    case "mock":
      return new DeterministicMockProvider(config, env);
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
