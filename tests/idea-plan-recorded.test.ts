import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";
import {IdeaPlanRunner} from "@academic-agent/agent-core";

const testDir = dirname(fileURLToPath(import.meta.url));
const tempRoots: string[] = [];

function writeConfig(root: string): void {
  const dir = join(root, ".academic-agent");
  mkdirSync(dir, {recursive: true});
  writeFileSync(
    join(dir, "config.toml"),
    [
      "[providers.planner]",
      'provider = "openai"',
      'model = "gpt-4.1-mini"',
      'api_key_env = "TEST_KEY"',
      "",
      "[providers.reviewer]",
      'provider = "openai"',
      'model = "gpt-4.1-mini"',
      'api_key_env = "TEST_KEY"',
      "",
      "[providers.extractor]",
      'provider = "openai"',
      'model = "gpt-4.1-mini"',
      'api_key_env = "TEST_KEY"',
    ].join("\n"),
    "utf8",
  );
}

function enableRecordedProvider(subdir: string): void {
  process.env.ACADEMIC_AGENT_RECORDED_PROVIDER = "1";
  process.env.ACADEMIC_AGENT_RECORDINGS_DIR = join(testDir, "recordings", subdir);
  process.env.ACADEMIC_AGENT_ENABLE_LIVE_PROVIDERS = "1";
  process.env.TEST_KEY = "test-key";
}

afterEach(() => {
  delete process.env.ACADEMIC_AGENT_RECORDED_PROVIDER;
  delete process.env.ACADEMIC_AGENT_RECORDINGS_DIR;
  delete process.env.ACADEMIC_AGENT_ENABLE_LIVE_PROVIDERS;
  delete process.env.TEST_KEY;
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, {recursive: true, force: true});
  }
});

describe("idea plan recorded run", () => {
  it("completes a run with recorded provider tool loop", async () => {
    const root = mkdtempSync(join(tmpdir(), "academic-agent-recorded-"));
    tempRoots.push(root);
    writeConfig(root);
    enableRecordedProvider("idea-plan");
    const {ProjectWorkspace} = await import("@academic-agent/workspace");
    const workspace = new ProjectWorkspace(root);
    const runner = new IdeaPlanRunner(workspace);
    const result = await runner.run("图像生成模型，文生图");
    expect(result.run.status).toBe("completed");
    expect(result.artifact.artifact_type).toBe("ResearchIdeaPlanDraft");
    expect(result.draft.diagnosis.problem.length).toBeGreaterThan(0);
    const evidence = workspace.count_thread_artifacts(result.run.thread_id, "PaperSearchEvidence");
    expect(evidence).toBeGreaterThan(0);
  });
});
