import type {ProviderProfileConfig, SetupLlmCandidate, SetupVerifyErrorCategory} from "@academic-agent/schemas";

import {openaiHeaders} from "./shared.js";

const VERIFY_TIMEOUT_MS = 15_000;

export type VerifyConnectionResult =
  | {ok: true}
  | {ok: false; category: SetupVerifyErrorCategory; message: string};

export function normalizeVerifyError(error: unknown): VerifyConnectionResult {
  if (error instanceof Error && error.name === "AbortError") {
    return {ok: false, category: "timeout", message: "Connection timed out"};
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("401") || lower.includes("authentication") || lower.includes("invalid api key")) {
    return {ok: false, category: "authentication_failed", message: "Authentication failed"};
  }
  if (lower.includes("404") || lower.includes("model") && lower.includes("not")) {
    return {ok: false, category: "model_unavailable", message: "Model unavailable"};
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return {ok: false, category: "rate_limited", message: "Rate limited"};
  }
  if (lower.includes("fetch failed") || lower.includes("network") || lower.includes("econn")) {
    return {ok: false, category: "network_failed", message: "Network request failed"};
  }
  return {ok: false, category: "provider_error", message: "Provider verification failed"};
}

function profileFromCandidate(candidate: SetupLlmCandidate): ProviderProfileConfig {
  return {
    profile: "planner",
    provider: candidate.provider,
    model: candidate.model,
    api_key_env: candidate.api_key_env,
    base_url: candidate.base_url ?? null,
    max_output_tokens: 8,
    temperature: 0,
    max_agent_iterations: 1,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    return await fetch(url, {...init, signal: controller.signal});
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyOpenAI(candidate: SetupLlmCandidate, apiKey: string): Promise<VerifyConnectionResult> {
  const baseUrl = (candidate.base_url ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetchWithTimeout(`${baseUrl}/responses`, {
    method: "POST",
    headers: openaiHeaders(apiKey),
    body: JSON.stringify({
      model: candidate.model,
      input: "OK",
      max_output_tokens: 5,
    }),
  });
  if (response.status === 401) {
    return {ok: false, category: "authentication_failed", message: "Authentication failed"};
  }
  if (response.status === 404) {
    return {ok: false, category: "model_unavailable", message: "Model unavailable"};
  }
  if (response.status === 429) {
    return {ok: false, category: "rate_limited", message: "Rate limited"};
  }
  if (!response.ok) {
    return {ok: false, category: "provider_error", message: "Provider verification failed"};
  }
  return {ok: true};
}

async function verifyAnthropic(candidate: SetupLlmCandidate, apiKey: string): Promise<VerifyConnectionResult> {
  const baseUrl = (candidate.base_url ?? "https://api.anthropic.com").replace(/\/$/, "");
  const response = await fetchWithTimeout(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: candidate.model,
      max_tokens: 5,
      messages: [{role: "user", content: "OK"}],
    }),
  });
  if (response.status === 401) {
    return {ok: false, category: "authentication_failed", message: "Authentication failed"};
  }
  if (response.status === 404) {
    return {ok: false, category: "model_unavailable", message: "Model unavailable"};
  }
  if (response.status === 429) {
    return {ok: false, category: "rate_limited", message: "Rate limited"};
  }
  if (!response.ok) {
    return {ok: false, category: "provider_error", message: "Provider verification failed"};
  }
  return {ok: true};
}

async function verifyOpenAICompatibleChat(
  candidate: SetupLlmCandidate,
  apiKey: string,
): Promise<VerifyConnectionResult> {
  if (!candidate.base_url) {
    return {ok: false, category: "provider_error", message: "Base URL is required"};
  }
  const baseUrl = candidate.base_url.replace(/\/$/, "");
  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: openaiHeaders(apiKey),
    body: JSON.stringify({
      model: candidate.model,
      messages: [{role: "user", content: "OK"}],
      max_tokens: 5,
    }),
  });
  if (response.status === 401) {
    return {ok: false, category: "authentication_failed", message: "Authentication failed"};
  }
  if (response.status === 404) {
    return {ok: false, category: "model_unavailable", message: "Model unavailable"};
  }
  if (response.status === 429) {
    return {ok: false, category: "rate_limited", message: "Rate limited"};
  }
  if (!response.ok) {
    return {ok: false, category: "provider_error", message: "Provider verification failed"};
  }
  return {ok: true};
}

export async function verifyLlmConnection(
  candidate: SetupLlmCandidate,
  apiKey: string,
): Promise<VerifyConnectionResult> {
  if (!apiKey.trim()) {
    return {ok: false, category: "authentication_failed", message: "API key is required"};
  }
  void profileFromCandidate(candidate);
  try {
    switch (candidate.provider) {
      case "openai":
        return await verifyOpenAI(candidate, apiKey);
      case "anthropic":
        return await verifyAnthropic(candidate, apiKey);
      case "deepseek":
        return await verifyOpenAICompatibleChat(
          {...candidate, base_url: candidate.base_url ?? "https://api.deepseek.com"},
          apiKey,
        );
      case "openai_compatible":
        return await verifyOpenAICompatibleChat(candidate, apiKey);
      default:
        return {ok: false, category: "provider_error", message: "Unsupported provider"};
    }
  } catch (error) {
    return normalizeVerifyError(error);
  }
}
