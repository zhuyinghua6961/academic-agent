import fs from "node:fs";
import path from "node:path";

import {renderDefaultProjectConfig} from "@academic-agent/config";

type ProviderEntry = {
  profile?: string;
  provider?: string;
  model?: string;
  api_key?: string;
  base_url?: string | null;
};

type SearchEntry = {
  source?: string;
  api_key?: string;
};

export type RuntimeCredentials = {
  project_root: string;
  providers?: Record<string, ProviderEntry>;
  search?: SearchEntry[];
};

const PROVIDER_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai_compatible: "ACADEMIC_AGENT_OPENAI_COMPATIBLE_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

const SEARCH_ENV: Record<string, string> = {
  brave: "BRAVE_SEARCH_API_KEY",
  tavily: "TAVILY_API_KEY",
  serper: "SERPER_API_KEY",
  serpapi: "SERPAPI_API_KEY",
};

function providerSection(profile: string, entry: ProviderEntry): string {
  const lines = [
    `[providers.${profile}]`,
    `provider = "${entry.provider ?? "openai"}"`,
    `model = "${entry.model ?? "gpt-4.1-mini"}"`,
  ];
  if (entry.base_url) {
    lines.push(`base_url = "${entry.base_url}"`);
  }
  return lines.join("\n");
}

export function applyRuntimeCredentials(credentials: RuntimeCredentials): void {
  const projectRoot = path.resolve(credentials.project_root);
  fs.mkdirSync(projectRoot, {recursive: true});
  const configPath = path.join(projectRoot, "config.toml");
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, renderDefaultProjectConfig(), "utf8");
  }

  const providers = credentials.providers ?? {};
  for (const [profile, entry] of Object.entries(providers)) {
    if (!entry.api_key) {
      continue;
    }
    const provider = String(entry.provider ?? "openai");
    const envName = PROVIDER_ENV[provider];
    if (envName) {
      process.env[envName] = entry.api_key;
    }
    if (provider === "openai_compatible" && entry.base_url) {
      process.env.ACADEMIC_AGENT_OPENAI_COMPATIBLE_BASE_URL = entry.base_url;
    }
    const section = providerSection(profile, entry);
    let config = fs.readFileSync(configPath, "utf8");
    const marker = `[providers.${profile}]`;
    if (config.includes(marker)) {
      config = config.replace(
        new RegExp(`\\[providers\\.${profile}\\][\\s\\S]*?(?=\\n\\[|$)`),
        section,
      );
    } else {
      config = `${config.trimEnd()}\n\n${section}\n`;
    }
    fs.writeFileSync(configPath, config, "utf8");
  }

  for (const entry of credentials.search ?? []) {
    if (!entry.source || !entry.api_key) {
      continue;
    }
    const envName = SEARCH_ENV[entry.source];
    if (envName) {
      process.env[envName] = entry.api_key;
    }
  }

  process.env.ACADEMIC_AGENT_ENABLE_LIVE_PROVIDERS = "1";
  process.env.ACADEMIC_AGENT_PROJECT_ROOT = projectRoot;
}
