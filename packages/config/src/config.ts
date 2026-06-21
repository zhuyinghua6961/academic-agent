import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ProviderProfileConfig, ProviderProfileStatus } from "@academic-agent/schemas";
import { parse as parseDotenv } from "dotenv";
import { parse as parseToml } from "smol-toml";

export type ProviderName =
  | "mock"
  | "openai"
  | "anthropic"
  | "openai_compatible"
  | "deepseek";

export type ProviderProfileName =
  | "planner"
  | "reviewer"
  | "writer"
  | "extractor"
  | "embedder";

export type SearchSource =
  | "arxiv"
  | "openalex"
  | "brave"
  | "tavily"
  | "serper"
  | "serpapi"
  | "duckduckgo";

export const PROFILE_NAMES: readonly ProviderProfileName[] = [
  "planner",
  "reviewer",
  "writer",
  "extractor",
  "embedder",
] as const;

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  mock: "mock-idea-diagnoser-v0",
  openai: "gpt-4.1-mini",
  anthropic: "claude-3-5-haiku-latest",
  openai_compatible: "local-openai-compatible-model",
  deepseek: "deepseek-chat",
};

const DEFAULT_API_KEY_ENVS: Record<ProviderName, string | null> = {
  mock: null,
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai_compatible: "ACADEMIC_AGENT_OPENAI_COMPATIBLE_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

const DEFAULT_BASE_URLS: Record<ProviderName, string | null> = {
  mock: null,
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  openai_compatible: "http://127.0.0.1:8000/v1",
  deepseek: "https://api.deepseek.com",
};

export const DEFAULT_SEARCH_API_KEY_ENVS: Record<SearchSource, string | null> = {
  arxiv: null,
  openalex: null,
  brave: "BRAVE_SEARCH_API_KEY",
  tavily: "TAVILY_API_KEY",
  serper: "SERPER_API_KEY",
  serpapi: "SERPAPI_API_KEY",
  duckduckgo: null,
};

const DEFAULT_SEARCH_BASE_URLS: Record<SearchSource, string | null> = {
  arxiv: "https://export.arxiv.org/api/query",
  openalex: "https://api.openalex.org/works",
  brave: "https://api.search.brave.com/res/v1/web/search",
  tavily: "https://api.tavily.com/search",
  serper: "https://google.serper.dev/search",
  serpapi: "https://serpapi.com/search.json",
  duckduckgo: null,
};

type JsonObject = Record<string, unknown>;

export class SearchProviderConfig {
  source: SearchSource;
  api_key_env: string | null;
  base_url: string | null;
  enabled: boolean;

  constructor(
    source: SearchSource,
    api_key_env: string | null,
    base_url: string | null,
    enabled = true,
  ) {
    this.source = source;
    this.api_key_env = api_key_env;
    this.base_url = base_url;
    this.enabled = enabled;
  }
}

export class SearchConfig {
  paper_sources: SearchSource[];
  web_sources: SearchSource[];
  providers: Record<SearchSource, SearchProviderConfig>;
  timeout_seconds: number;
  trust_env: boolean;

  constructor(
    paper_sources: SearchSource[],
    web_sources: SearchSource[],
    providers: Record<SearchSource, SearchProviderConfig>,
    timeout_seconds = 30.0,
    trust_env = true,
  ) {
    this.paper_sources = paper_sources;
    this.web_sources = web_sources;
    this.providers = providers;
    this.timeout_seconds = timeout_seconds;
    this.trust_env = trust_env;
  }
}

export class ContextCompactionConfig {
  enabled: boolean;
  context_window_tokens: number | null;
  model_context_tokens: number | null;
  compact_trigger_ratio: number;
  max_history_tokens: number;
  response_token_reserve: number;
  system_tool_token_reserve: number;
  chars_per_token: number;
  min_recent_messages: number;
  max_recent_messages: number;
  recent_token_ratio: number;
  important_message_limit: number;
  important_token_ratio: number;
  summary_token_ratio: number;
  per_message_token_limit: number;
  artifact_token_ratio: number;
  artifact_max_tokens: number;
  paper_evidence_limit: number;

  constructor(options: {
    enabled?: boolean;
    context_window_tokens?: number | null;
    model_context_tokens?: number | null;
    compact_trigger_ratio?: number;
    max_history_tokens?: number;
    response_token_reserve?: number;
    system_tool_token_reserve?: number;
    chars_per_token?: number;
    min_recent_messages?: number;
    max_recent_messages?: number;
    recent_token_ratio?: number;
    important_message_limit?: number;
    important_token_ratio?: number;
    summary_token_ratio?: number;
    per_message_token_limit?: number;
    artifact_token_ratio?: number;
    artifact_max_tokens?: number;
    paper_evidence_limit?: number;
  } = {}) {
    const resolvedContextWindowTokens =
      options.context_window_tokens ?? options.model_context_tokens ?? null;
    this.enabled = options.enabled ?? true;
    this.context_window_tokens = resolvedContextWindowTokens;
    this.model_context_tokens = resolvedContextWindowTokens;
    this.compact_trigger_ratio = options.compact_trigger_ratio ?? 0.85;
    this.max_history_tokens = options.max_history_tokens ?? 2400;
    this.response_token_reserve = options.response_token_reserve ?? 1600;
    this.system_tool_token_reserve = options.system_tool_token_reserve ?? 2600;
    this.chars_per_token = options.chars_per_token ?? 4.0;
    this.min_recent_messages = options.min_recent_messages ?? 4;
    this.max_recent_messages = options.max_recent_messages ?? 16;
    this.recent_token_ratio = options.recent_token_ratio ?? 0.55;
    this.important_message_limit = options.important_message_limit ?? 6;
    this.important_token_ratio = options.important_token_ratio ?? 0.25;
    this.summary_token_ratio = options.summary_token_ratio ?? 0.35;
    this.per_message_token_limit = options.per_message_token_limit ?? 240;
    this.artifact_token_ratio = options.artifact_token_ratio ?? 0.2;
    this.artifact_max_tokens = options.artifact_max_tokens ?? 4000;
    this.paper_evidence_limit = options.paper_evidence_limit ?? 3;
  }
}

export class MemoryConfig {
  retrieval_limit: number;
  vector_dimensions: number;
  paper_evidence_ttl_days: number;
  stale_recheck_enabled: boolean;
  conflict_detection_enabled: boolean;

  constructor(
    retrieval_limit = 8,
    vector_dimensions = 96,
    paper_evidence_ttl_days = 30,
    stale_recheck_enabled = true,
    conflict_detection_enabled = true,
  ) {
    this.retrieval_limit = retrieval_limit;
    this.vector_dimensions = vector_dimensions;
    this.paper_evidence_ttl_days = paper_evidence_ttl_days;
    this.stale_recheck_enabled = stale_recheck_enabled;
    this.conflict_detection_enabled = conflict_detection_enabled;
  }
}

export function liveProvidersEnabled(env?: Readonly<Record<string, string>>): boolean {
  const source = env ?? process.env;
  const value = source.ACADEMIC_AGENT_ENABLE_LIVE_PROVIDERS ?? "";
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function mockProviderAllowed(env: Readonly<Record<string, string>>): boolean {
  const value = env.ACADEMIC_AGENT_ALLOW_MOCK ?? "";
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export class ConfigurationRequiredError extends Error {
  readonly code = "configuration_required";

  constructor(message = "Provider configuration required") {
    super(message);
    this.name = "ConfigurationRequiredError";
  }
}

export class AgentConfig {
  profiles: Partial<Record<ProviderProfileName, ProviderProfileConfig>>;
  search: SearchConfig;
  context_compaction: ContextCompactionConfig;
  memory: MemoryConfig;
  sources: string[];
  env: Record<string, string>;

  constructor(options: {
    profiles: Partial<Record<ProviderProfileName, ProviderProfileConfig>>;
    search: SearchConfig;
    context_compaction: ContextCompactionConfig;
    memory: MemoryConfig;
    sources: string[];
    env?: Record<string, string>;
  }) {
    this.profiles = options.profiles;
    this.search = options.search;
    this.context_compaction = options.context_compaction;
    this.memory = options.memory;
    this.sources = options.sources;
    this.env = {...(options.env ?? process.env as Record<string, string>)};
  }

  static load(projectRoot: string, env?: Record<string, string>): AgentConfig {
    const sourceEnv = loadEnv(projectRoot, env);
    const sources: string[] = [];
    const rawProfiles: Record<string, JsonObject> = {};
    let rawSearch: JsonObject = {};
    let rawContext: JsonObject = {};
    let rawMemory: JsonObject = {};

    for (const configPath of configPaths(projectRoot, sourceEnv)) {
      if (existsSync(configPath)) {
        const data = parseToml(readFileSync(configPath, "utf-8")) as JsonObject;
        sources.push(configPath);
        const providers = data.providers;
        if (providers && typeof providers === "object" && !Array.isArray(providers)) {
          for (const [name, payload] of Object.entries(providers)) {
            if (payload && typeof payload === "object" && !Array.isArray(payload)) {
              rawProfiles[name] = {...(rawProfiles[name] ?? {}), ...(payload as JsonObject)};
            }
          }
        }
        if (data.search && typeof data.search === "object" && !Array.isArray(data.search)) {
          rawSearch = deepMerge(rawSearch, data.search as JsonObject);
        }
        if (data.context && typeof data.context === "object" && !Array.isArray(data.context)) {
          rawContext = deepMerge(rawContext, data.context as JsonObject);
        }
        if (data.memory && typeof data.memory === "object" && !Array.isArray(data.memory)) {
          rawMemory = deepMerge(rawMemory, data.memory as JsonObject);
        }
      }
    }

    const profiles = defaultProfiles({ includePlanner: false });
    for (const [name, payload] of Object.entries(rawProfiles)) {
      if (isProviderProfileName(name)) {
        const profile = profileFromPayload(name, payload);
        if (profile.provider !== "mock" || mockProviderAllowed(sourceEnv)) {
          profiles[name] = profile;
        }
      }
    }

    if (!profiles.planner && mockProviderAllowed(sourceEnv)) {
      profiles.planner = mockProfile("planner");
    }

    applyEnvOverrides(profiles, sourceEnv);
    return new AgentConfig({
      profiles,
      search: searchConfigFromRaw(rawSearch),
      context_compaction: contextCompactionFromRaw(rawContext),
      memory: memoryConfigFromRaw(rawMemory),
      sources,
      env: sourceEnv,
    });
  }

  profile(name: ProviderProfileName): ProviderProfileConfig {
    const config = this.profiles[name];
    if (config === undefined) {
      throw new ConfigurationRequiredError(
        `configuration required for provider profile: ${name}`,
      );
    }
    return config;
  }

  planner_or_none(): ProviderProfileConfig | null {
    return this.profiles.planner ?? null;
  }

  setup_state(): "unconfigured" | "invalid" | "configured" {
    const planner = this.planner_or_none();
    if (planner === null) {
      return "unconfigured";
    }
    if (planner.provider === "mock") {
      return mockProviderAllowed(this.env) ? "configured" : "unconfigured";
    }
    const hasKey = Boolean(planner.api_key_env && this.env[planner.api_key_env]);
    if (!hasKey || !liveProvidersEnabled(this.env)) {
      return "invalid";
    }
    if (planner.provider === "openai_compatible" && !planner.base_url) {
      return "invalid";
    }
    return "configured";
  }

  statuses(): ProviderProfileStatus[] {
    const liveEnabled = liveProvidersEnabled(this.env);
    const statuses: ProviderProfileStatus[] = [];
    for (const profileName of PROFILE_NAMES) {
      const config = this.profiles[profileName];
      if (config === undefined) {
        continue;
      }
      const hasApiKey = Boolean(config.api_key_env && this.env[config.api_key_env]);
      statuses.push({
        profile: config.profile,
        provider: config.provider,
        model: config.model,
        api_key_env: config.api_key_env,
        has_api_key: hasApiKey,
        base_url: config.base_url,
        reasoning_effort: config.reasoning_effort,
        reasoning_summary: config.reasoning_summary,
        live_enabled: liveEnabled,
        will_use_live: config.provider !== "mock" && liveEnabled && hasApiKey,
      });
    }
    return statuses;
  }
}

export function renderDefaultProjectConfig(): string {
  return (
    "# Academic Agent project config\n" +
    "# Configure the planner through the first-run setup. Secrets stay in env files.\n\n" +
    "[runtime]\n" +
    'core_host = "127.0.0.1"\n' +
    "core_port = 8765\n\n" +
    "[context.compaction]\n" +
    "enabled = true\n" +
    "# Leave context_window_tokens unset or 0 to infer a conservative model window.\n" +
    "context_window_tokens = 0\n" +
    "# Compact thread history when estimated history tokens pass this ratio of the history budget.\n" +
    "compact_trigger_ratio = 0.85\n" +
    "# Max token budget for thread history after reserving system/tool/output budget.\n" +
    "max_history_tokens = 2400\n" +
    "response_token_reserve = 1600\n" +
    "system_tool_token_reserve = 2600\n" +
    "chars_per_token = 4.0\n" +
    "min_recent_messages = 4\n" +
    "max_recent_messages = 16\n" +
    "recent_token_ratio = 0.55\n" +
    "important_message_limit = 6\n" +
    "important_token_ratio = 0.25\n" +
    "summary_token_ratio = 0.35\n" +
    "per_message_token_limit = 240\n\n" +
    "# Artifact-first memory context: current plan/review/evidence is injected before chat history.\n" +
    "artifact_token_ratio = 0.20\n" +
    "artifact_max_tokens = 4000\n" +
    "paper_evidence_limit = 3\n\n" +
    "[memory]\n" +
    "retrieval_limit = 8\n" +
    "vector_dimensions = 96\n" +
    "paper_evidence_ttl_days = 30\n" +
    "stale_recheck_enabled = true\n" +
    "conflict_detection_enabled = true\n\n" +
    "# Example OpenAI planner profile:\n" +
    "# [providers.planner]\n" +
    '# provider = "openai"\n' +
    '# model = "gpt-5.1"\n' +
    '# api_key_env = "OPENAI_API_KEY"\n' +
    '# base_url = "https://api.openai.com/v1"\n' +
    '# max_output_tokens = 3000\n' +
    '# reasoning_effort = "medium"\n' +
    '# reasoning_summary = "auto"\n' +
    "#\n" +
    "# Example OpenAI-compatible planner profile, such as a local gateway,\n" +
    "# vLLM server, LiteLLM proxy, or another /chat/completions-compatible endpoint:\n" +
    "# [providers.planner]\n" +
    '# provider = "openai_compatible"\n' +
    '# model = "your-model-name"\n' +
    '# api_key_env = "ACADEMIC_AGENT_OPENAI_COMPATIBLE_API_KEY"\n' +
    '# base_url = "http://127.0.0.1:8000/v1"\n' +
    "#\n" +
    "# You can also override planner provider settings with env vars:\n" +
    "# ACADEMIC_AGENT_PROVIDER, ACADEMIC_AGENT_MODEL,\n" +
    "# ACADEMIC_AGENT_BASE_URL, ACADEMIC_AGENT_API_KEY_ENV,\n" +
    "# ACADEMIC_AGENT_REASONING_EFFORT, ACADEMIC_AGENT_REASONING_SUMMARY.\n" +
    "\n[search]\n" +
    'paper_sources = ["arxiv", "openalex"]\n' +
    'web_sources = ["brave", "tavily", "serper", "serpapi", "duckduckgo"]\n' +
    "timeout_seconds = 30\n" +
    "trust_env = true\n\n" +
    "[search.brave]\n" +
    'api_key_env = "BRAVE_SEARCH_API_KEY"\n' +
    'base_url = "https://api.search.brave.com/res/v1/web/search"\n\n' +
    "[search.tavily]\n" +
    'api_key_env = "TAVILY_API_KEY"\n' +
    'base_url = "https://api.tavily.com/search"\n\n' +
    "[search.serper]\n" +
    'api_key_env = "SERPER_API_KEY"\n' +
    'base_url = "https://google.serper.dev/search"\n\n' +
    "[search.serpapi]\n" +
    'api_key_env = "SERPAPI_API_KEY"\n' +
    'base_url = "https://serpapi.com/search.json"\n'
  );
}

export function projectAgentConfigPath(projectRoot: string): string {
  return join(projectRoot, ".academic-agent", "config.toml");
}

export function globalAgentEnvPath(env: Record<string, string>): string {
  const home = env.HOME;
  if (!home) {
    throw new Error("HOME is required to resolve global credentials path");
  }
  return join(home, ".academic-agent", ".env");
}

export function loadMergedEnv(projectRoot: string, env?: Record<string, string>): Record<string, string> {
  return loadEnv(projectRoot, env);
}

function configPaths(projectRoot: string, env: Record<string, string>): string[] {
  const paths: string[] = [];
  const home = env.HOME;
  if (home) {
    paths.push(join(home, ".academic-agent", "config.toml"));
  }
  paths.push(join(projectRoot, ".academic-agent", "config.toml"));
  const explicit = env.ACADEMIC_AGENT_CONFIG;
  if (explicit) {
    paths.push(explicit);
  }
  return paths;
}

function loadEnv(projectRoot: string, env?: Record<string, string>): Record<string, string> {
  const processEnv = {...(env ?? (process.env as Record<string, string>))};
  const merged: Record<string, string> = {};
  const home = processEnv.HOME;
  const envPaths: string[] = [];
  if (home) {
    envPaths.push(join(home, ".academic-agent", ".env"));
  }
  envPaths.push(join(projectRoot, ".env"), join(projectRoot, ".academic-agent", ".env"));
  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      const parsed = parseDotenv(readFileSync(envPath, "utf-8"));
      for (const [key, value] of Object.entries(parsed)) {
        if (value !== undefined) {
          merged[key] = value;
        }
      }
    }
  }
  Object.assign(merged, processEnv);
  return merged;
}

function isProviderName(value: unknown): value is ProviderName {
  return (
    value === "mock" ||
    value === "openai" ||
    value === "anthropic" ||
    value === "openai_compatible" ||
    value === "deepseek"
  );
}

function isProviderProfileName(value: string): value is ProviderProfileName {
  return (PROFILE_NAMES as readonly string[]).includes(value);
}

function isSearchSource(value: unknown): value is SearchSource {
  return typeof value === "string" && value in DEFAULT_SEARCH_API_KEY_ENVS;
}

function validateProviderProfileConfig(raw: JsonObject): ProviderProfileConfig {
  const profile = raw.profile;
  const provider = raw.provider;
  if (typeof profile !== "string" || !isProviderProfileName(profile)) {
    throw new Error(`invalid provider profile: ${String(profile)}`);
  }
  if (!isProviderName(provider)) {
    throw new Error(`invalid provider: ${String(provider)}`);
  }
  return {
    profile,
    provider,
    model: String(raw.model ?? DEFAULT_MODELS.mock),
    api_key_env: optionalStr(raw.api_key_env, null),
    base_url: optionalStr(raw.base_url, null),
    max_output_tokens: positiveInt(raw.max_output_tokens, 900),
    temperature:
      raw.temperature !== undefined && raw.temperature !== null
        ? Math.max(0, floatValue(raw.temperature, 0.2))
        : 0.2,
    reasoning_effort:
      (raw.reasoning_effort as ProviderProfileConfig["reasoning_effort"]) ?? null,
    reasoning_summary:
      (raw.reasoning_summary as ProviderProfileConfig["reasoning_summary"]) ?? null,
    max_agent_iterations: Math.min(20, Math.max(1, positiveInt(raw.max_agent_iterations, 5))),
  };
}

function mockProfile(profile: ProviderProfileName): ProviderProfileConfig {
  return validateProviderProfileConfig({
    profile,
    provider: "mock",
    model: DEFAULT_MODELS.mock,
    api_key_env: null,
    base_url: null,
  });
}

function defaultProfiles(options: {
  includePlanner?: boolean;
}): Partial<Record<ProviderProfileName, ProviderProfileConfig>> {
  const includePlanner = options.includePlanner ?? true;
  const profiles: Partial<Record<ProviderProfileName, ProviderProfileConfig>> = {};
  for (const profile of PROFILE_NAMES) {
    if (includePlanner || profile !== "planner") {
      profiles[profile] = mockProfile(profile);
    }
  }
  return profiles;
}

function profileFromPayload(
  profileName: ProviderProfileName,
  payload: JsonObject,
): ProviderProfileConfig {
  const provider = isProviderName(payload.provider) ? payload.provider : "mock";
  const current: JsonObject = {
    provider,
    model: DEFAULT_MODELS[provider] ?? DEFAULT_MODELS.mock,
    api_key_env: DEFAULT_API_KEY_ENVS[provider],
    base_url: DEFAULT_BASE_URLS[provider],
    ...payload,
    profile: profileName,
  };
  return validateProviderProfileConfig(current);
}

function defaultSearchProviders(): Record<SearchSource, SearchProviderConfig> {
  const providers = {} as Record<SearchSource, SearchProviderConfig>;
  for (const source of Object.keys(DEFAULT_SEARCH_API_KEY_ENVS) as SearchSource[]) {
    providers[source] = new SearchProviderConfig(
      source,
      DEFAULT_SEARCH_API_KEY_ENVS[source],
      DEFAULT_SEARCH_BASE_URLS[source],
      true,
    );
  }
  return providers;
}

function searchConfigFromRaw(rawSearch: JsonObject): SearchConfig {
  const providers = defaultSearchProviders();
  const paperSources = searchSourceList(rawSearch.paper_sources, ["arxiv", "openalex"]);
  const webSources = searchSourceList(rawSearch.web_sources, [
    "brave",
    "tavily",
    "serper",
    "serpapi",
    "duckduckgo",
  ]);
  const timeoutSeconds = floatValue(rawSearch.timeout_seconds, 30.0);
  const trustEnv = rawSearch.trust_env !== undefined ? Boolean(rawSearch.trust_env) : true;

  for (const [source, provider] of Object.entries(providers) as [SearchSource, SearchProviderConfig][]) {
    const payload = rawSearch[source];
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      continue;
    }
    const providerPayload = payload as JsonObject;
    provider.api_key_env = optionalStr(providerPayload.api_key_env, provider.api_key_env);
    provider.base_url = optionalStr(providerPayload.base_url, provider.base_url);
    if ("enabled" in providerPayload) {
      provider.enabled = Boolean(providerPayload.enabled);
    }
  }

  return new SearchConfig(
    paperSources,
    webSources,
    providers,
    timeoutSeconds,
    trustEnv,
  );
}

function contextCompactionFromRaw(rawContext: JsonObject): ContextCompactionConfig {
  const rawCompaction = rawContext.compaction;
  const compaction =
    rawCompaction && typeof rawCompaction === "object" && !Array.isArray(rawCompaction)
      ? (rawCompaction as JsonObject)
      : {};
  const contextWindowTokens = positiveOptionalInt(compaction.context_window_tokens);
  const modelContextTokens = positiveOptionalInt(compaction.model_context_tokens);
  return new ContextCompactionConfig({
    enabled: compaction.enabled !== undefined ? Boolean(compaction.enabled) : true,
    context_window_tokens: contextWindowTokens,
    model_context_tokens: modelContextTokens,
    compact_trigger_ratio: ratioValue(compaction.compact_trigger_ratio, 0.85),
    max_history_tokens: positiveInt(compaction.max_history_tokens, 2400),
    response_token_reserve: positiveInt(compaction.response_token_reserve, 1600),
    system_tool_token_reserve: positiveInt(compaction.system_tool_token_reserve, 2600),
    chars_per_token: Math.max(1.0, floatValue(compaction.chars_per_token, 4.0)),
    min_recent_messages: positiveInt(compaction.min_recent_messages, 4),
    max_recent_messages: positiveInt(compaction.max_recent_messages, 16),
    recent_token_ratio: ratioValue(compaction.recent_token_ratio, 0.55),
    important_message_limit: positiveInt(compaction.important_message_limit, 6),
    important_token_ratio: ratioValue(compaction.important_token_ratio, 0.25),
    summary_token_ratio: ratioValue(compaction.summary_token_ratio, 0.35),
    per_message_token_limit: positiveInt(compaction.per_message_token_limit, 240),
    artifact_token_ratio: ratioValue(compaction.artifact_token_ratio, 0.2),
    artifact_max_tokens: positiveInt(compaction.artifact_max_tokens, 4000),
    paper_evidence_limit: positiveInt(compaction.paper_evidence_limit, 3),
  });
}

function memoryConfigFromRaw(rawMemory: JsonObject): MemoryConfig {
  return new MemoryConfig(
    positiveInt(rawMemory.retrieval_limit, 8),
    positiveInt(rawMemory.vector_dimensions, 96),
    positiveInt(rawMemory.paper_evidence_ttl_days, 30),
    rawMemory.stale_recheck_enabled !== undefined
      ? Boolean(rawMemory.stale_recheck_enabled)
      : true,
    rawMemory.conflict_detection_enabled !== undefined
      ? Boolean(rawMemory.conflict_detection_enabled)
      : true,
  );
}

function searchSourceList(value: unknown, fallback: SearchSource[]): SearchSource[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const sources = value.filter(isSearchSource);
  return sources.length > 0 ? sources : fallback;
}

function optionalStr(value: unknown, fallback: string | null): string | null {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function positiveOptionalInt(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed > 0 ? parsed : null;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = positiveOptionalInt(value);
  return parsed ?? fallback;
}

function floatValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ratioValue(value: unknown, fallback: number): number {
  const parsed = floatValue(value, fallback);
  return Math.min(0.95, Math.max(0.05, parsed));
}

function deepMerge(left: JsonObject, right: JsonObject): JsonObject {
  const merged: JsonObject = {...left};
  for (const [key, value] of Object.entries(right)) {
    const existing = merged[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      merged[key] = deepMerge(existing as JsonObject, value as JsonObject);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function applyEnvOverrides(
  profiles: Partial<Record<ProviderProfileName, ProviderProfileConfig>>,
  env: Record<string, string>,
): void {
  const provider = env.ACADEMIC_AGENT_PROVIDER;
  const model = env.ACADEMIC_AGENT_MODEL;
  const baseUrl = env.ACADEMIC_AGENT_BASE_URL;
  const apiKeyEnv = env.ACADEMIC_AGENT_API_KEY_ENV;
  const reasoningEffort = env.ACADEMIC_AGENT_REASONING_EFFORT;
  const reasoningSummary = env.ACADEMIC_AGENT_REASONING_SUMMARY;
  if (
    !provider &&
    !model &&
    !baseUrl &&
    !apiKeyEnv &&
    !reasoningEffort &&
    !reasoningSummary
  ) {
    return;
  }

  let planner: JsonObject;
  if (profiles.planner) {
    planner = {...profiles.planner};
  } else if (provider) {
    planner = {...profileFromPayload("planner", {provider})};
  } else {
    return;
  }

  if (provider) {
    planner.provider = provider;
    if (isProviderName(provider)) {
      planner.model = model ?? DEFAULT_MODELS[provider];
      planner.api_key_env = apiKeyEnv ?? DEFAULT_API_KEY_ENVS[provider];
      planner.base_url = baseUrl ?? DEFAULT_BASE_URLS[provider];
    }
  }
  if (model) {
    planner.model = model;
  }
  if (baseUrl) {
    planner.base_url = baseUrl;
  }
  if (apiKeyEnv) {
    planner.api_key_env = apiKeyEnv;
  }
  if (reasoningEffort) {
    planner.reasoning_effort = reasoningEffort;
  }
  if (reasoningSummary) {
    planner.reasoning_summary = reasoningSummary;
  }
  profiles.planner = validateProviderProfileConfig(planner);
}
