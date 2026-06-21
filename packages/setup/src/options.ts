import {createHash} from "node:crypto";

import type {
  SetupApplyRequest,
  SetupApplyResponse,
  SetupKeyedSearchSource,
  SetupLlmCandidate,
  SetupProviderOption,
  SetupSearchStatus,
  SetupStatusResponse,
  SetupVerifyLlmRequest,
  SetupVerifyLlmResponse,
  SetupVerifySearchRequest,
  SetupVerifySearchResponse,
} from "@academic-agent/schemas";

export const PROVIDER_OPTIONS: SetupProviderOption[] = [
  {
    provider: "openai",
    label: "OpenAI",
    default_model: "gpt-4.1-mini",
    default_api_key_env: "OPENAI_API_KEY",
    default_base_url: "https://api.openai.com/v1",
    requires_base_url: false,
  },
  {
    provider: "anthropic",
    label: "Anthropic",
    default_model: "claude-3-5-haiku-latest",
    default_api_key_env: "ANTHROPIC_API_KEY",
    default_base_url: "https://api.anthropic.com",
    requires_base_url: false,
  },
  {
    provider: "deepseek",
    label: "DeepSeek",
    default_model: "deepseek-chat",
    default_api_key_env: "DEEPSEEK_API_KEY",
    default_base_url: "https://api.deepseek.com",
    requires_base_url: false,
  },
  {
    provider: "openai_compatible",
    label: "OpenAI-compatible",
    default_model: "local-openai-compatible-model",
    default_api_key_env: "ACADEMIC_AGENT_OPENAI_COMPATIBLE_API_KEY",
    default_base_url: "http://127.0.0.1:8000/v1",
    requires_base_url: true,
  },
];

const KEYED_SEARCH_SOURCES: SetupKeyedSearchSource[] = ["brave", "tavily", "serper", "serpapi"];

const SEARCH_LABELS: Record<SetupKeyedSearchSource, string> = {
  brave: "Brave Search",
  tavily: "Tavily",
  serper: "Serper",
  serpapi: "SerpAPI",
};

export function candidateHash(candidate: SetupLlmCandidate): string {
  return createHash("sha256")
    .update(JSON.stringify(candidate))
    .digest("hex");
}

export function secretFingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function searchCandidateHash(source: SetupKeyedSearchSource): string {
  return createHash("sha256").update(`search:${source}`).digest("hex");
}

export {KEYED_SEARCH_SOURCES, SEARCH_LABELS};
