import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterEach, describe, expect, it} from "vitest";

import {AgentConfig, loadMergedEnv, renderDefaultProjectConfig} from "@academic-agent/config";
import type {SetupLlmCandidate} from "@academic-agent/schemas";
import {SetupManager, candidateHash, secretFingerprint} from "@academic-agent/setup";
import {ProjectWorkspace} from "@academic-agent/workspace";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, {recursive: true, force: true});
    }
  }
});

function createProject(): {root: string; home: string} {
  const root = mkdtempSync(join(tmpdir(), "aa-setup-"));
  const home = join(root, "home");
  mkdirSync(join(root, ".academic-agent"), {recursive: true});
  mkdirSync(join(home, ".academic-agent"), {recursive: true});
  writeFileSync(join(root, ".academic-agent", "config.toml"), renderDefaultProjectConfig());
  new ProjectWorkspace(root).init();
  tempRoots.push(root);
  return {root, home};
}

const openaiCandidate = (): SetupLlmCandidate => ({
  provider: "openai",
  model: "gpt-4.1-mini",
  api_key_env: "OPENAI_API_KEY",
  base_url: "https://api.openai.com/v1",
});

describe("SetupManager", () => {
  it("reports unconfigured status without secrets", () => {
    const {root, home} = createProject();
    const manager = new SetupManager(root, {env: {HOME: home}});
    const status = manager.status();
    expect(status.state).toBe("unconfigured");
    expect(status.setup_required).toBe(true);
    expect(JSON.stringify(status).toLowerCase()).not.toContain("sk-");
  });

  it("verify returns token without echoing secret", async () => {
    const {root, home} = createProject();
    const manager = new SetupManager(root, {
      env: {HOME: home},
      llmVerifier: async () => ({verified: true}),
    });
    const result = await manager.verifyLlm({
      candidate: openaiCandidate(),
      api_key: "sk-test-secret",
    });
    expect(result.verified).toBe(true);
    expect(result.verification_id).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain("sk-test-secret");
  });

  it("apply persists planner config and global env", async () => {
    const {root, home} = createProject();
    const manager = new SetupManager(root, {
      env: {HOME: home},
      llmVerifier: async () => ({verified: true}),
    });
    const candidate = openaiCandidate();
    const verify = await manager.verifyLlm({
      candidate,
      api_key: "sk-secret",
    });
    const applied = manager.apply({
      llm_verification_id: verify.verification_id!,
      candidate,
      api_key: "sk-secret",
      search_verification_ids: {},
      search_api_keys: {},
      enabled_search_sources: ["arxiv", "openalex", "duckduckgo"],
    });
    const configText = readFileSync(join(root, ".academic-agent", "config.toml"), "utf-8");
    expect(configText).toContain("openai");
    expect(configText).not.toContain("sk-secret");
    const envText = readFileSync(join(home, ".academic-agent", ".env"), "utf-8");
    expect(envText).toContain("OPENAI_API_KEY=sk-secret");
    expect(envText).toContain("ACADEMIC_AGENT_ENABLE_LIVE_PROVIDERS=1");
    const merged = loadMergedEnv(root, {HOME: home});
    expect(merged.OPENAI_API_KEY).toBe("sk-secret");
    expect(merged.ACADEMIC_AGENT_ENABLE_LIVE_PROVIDERS).toBe("1");
    const config = AgentConfig.load(root, merged);
    expect(config.setup_state()).toBe("configured");
    expect(applied.state).toBe("configured");
  });

  it("rejects expired verification on apply", async () => {
    const {root, home} = createProject();
    let now = 0;
    const manager = new SetupManager(root, {
      env: {HOME: home},
      now: () => now,
      llmVerifier: async () => ({verified: true}),
    });
    const candidate = openaiCandidate();
    const verify = await manager.verifyLlm({candidate, api_key: "sk-secret"});
    now = 6 * 60 * 1000;
    expect(() =>
      manager.apply({
        llm_verification_id: verify.verification_id!,
        candidate,
        api_key: "sk-secret",
        search_verification_ids: {},
        search_api_keys: {},
        enabled_search_sources: [],
      }),
    ).toThrow(/expired|not found/i);
  });

  it("binds verification to candidate hash", () => {
    const candidate = openaiCandidate();
    const hash = candidateHash(candidate);
    const fingerprint = secretFingerprint("sk-secret");
    expect(hash).not.toEqual(fingerprint);
  });
});
