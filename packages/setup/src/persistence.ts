import {chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";

import {globalAgentEnvPath, projectAgentConfigPath, renderDefaultProjectConfig} from "@academic-agent/config";
import type {SearchSource, SetupLlmCandidate} from "@academic-agent/schemas";
import {parse as parseToml, stringify as stringifyToml} from "smol-toml";

type JsonObject = Record<string, unknown>;

const KEYED_WEB_SOURCES = new Set<SearchSource>(["brave", "tavily", "serper", "serpapi"]);

function atomicWriteFile(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), {recursive: true});
  const tempPath = join(dirname(path), `.${path.split("/").pop()}.tmp-${process.pid}`);
  writeFileSync(tempPath, content, {encoding: "utf-8", mode: mode ?? 0o644});
  renameSync(tempPath, path);
  if (mode !== undefined) {
    chmodSync(path, mode);
  }
}

function patchEnvFile(path: string, updates: Record<string, string>): string {
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const lines = existing.length > 0 ? existing.split("\n") : [];
  const managedKeys = new Set(Object.keys(updates));
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return true;
    }
    const key = trimmed.split("=")[0]?.trim();
    return !key || !managedKeys.has(key);
  });
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === "") {
    kept.pop();
  }
  for (const [key, value] of Object.entries(updates)) {
    kept.push(`${key}=${value}`);
  }
  return `${kept.join("\n").trimEnd()}\n`;
}

function patchProjectConfig(
  baseText: string,
  candidate: SetupLlmCandidate,
  enabledSearchSources: SearchSource[],
): string {
  const doc = parseToml(baseText) as JsonObject;
  const providers = (doc.providers as JsonObject | undefined) ?? {};
  const planner: JsonObject = {
    provider: candidate.provider,
    model: candidate.model,
    api_key_env: candidate.api_key_env,
  };
  if (candidate.base_url) {
    planner.base_url = candidate.base_url;
  }
  providers.planner = planner;
  doc.providers = providers;

  const search = (doc.search as JsonObject | undefined) ?? {};
  const keyed = enabledSearchSources.filter((source) => KEYED_WEB_SOURCES.has(source));
  search.paper_sources = ["arxiv", "openalex"];
  search.web_sources = ["duckduckgo", ...keyed];
  doc.search = search;

  return stringifyToml(doc);
}

export function applySetupConfiguration(options: {
  projectRoot: string;
  env: Record<string, string>;
  candidate: SetupLlmCandidate;
  apiKey: string;
  enabledSearchSources: SearchSource[];
}): void {
  const configPath = projectAgentConfigPath(options.projectRoot);
  const baseText = existsSync(configPath) ? readFileSync(configPath, "utf-8") : renderDefaultProjectConfig();
  atomicWriteFile(
    configPath,
    patchProjectConfig(baseText, options.candidate, options.enabledSearchSources),
  );

  const globalEnv = globalAgentEnvPath(options.env);
  const envUpdates: Record<string, string> = {
    [options.candidate.api_key_env]: options.apiKey,
    ACADEMIC_AGENT_ENABLE_LIVE_PROVIDERS: "1",
  };
  for (const source of options.enabledSearchSources) {
    if (source === "brave" && options.env.BRAVE_SEARCH_API_KEY) {
      envUpdates.BRAVE_SEARCH_API_KEY = options.env.BRAVE_SEARCH_API_KEY;
    } else if (source === "tavily" && options.env.TAVILY_API_KEY) {
      envUpdates.TAVILY_API_KEY = options.env.TAVILY_API_KEY;
    } else if (source === "serper" && options.env.SERPER_API_KEY) {
      envUpdates.SERPER_API_KEY = options.env.SERPER_API_KEY;
    } else if (source === "serpapi" && options.env.SERPAPI_API_KEY) {
      envUpdates.SERPAPI_API_KEY = options.env.SERPAPI_API_KEY;
    }
  }
  atomicWriteFile(globalEnv, patchEnvFile(globalEnv, envUpdates), 0o600);
}

export function readStoredApiKey(env: Record<string, string>, apiKeyEnv: string): string | null {
  const value = env[apiKeyEnv];
  return value && value.trim() ? value : null;
}
