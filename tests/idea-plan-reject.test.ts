import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";
import {IdeaPlanRunner, loadConvergenceForThread} from "@academic-agent/agent-core";

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

function enableRecordedProvider(): void {
  process.env.ACADEMIC_AGENT_RECORDED_PROVIDER = "1";
  process.env.ACADEMIC_AGENT_RECORDINGS_DIR = join(testDir, "recordings", "idea-plan");
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

describe("idea plan reject path", () => {
  it("records Reject review and keeps freeze gate closed", async () => {
    const root = mkdtempSync(join(tmpdir(), "idea-plan-reject-"));
    tempRoots.push(root);
    writeConfig(root);
    enableRecordedProvider();
    const {ProjectWorkspace} = await import("@academic-agent/workspace");
    const workspace = new ProjectWorkspace(root);
    workspace.init();
    const runner = new IdeaPlanRunner(workspace);
    const result = await runner.run("图像生成模型，文生图");
    expect(result.run.status).toBe("completed");

    const artifact = workspace.latest_plan_artifact_for_thread(result.run.thread_id);
    expect(artifact).not.toBeNull();
    workspace.record_idea_review(
      result.run.thread_id,
      artifact!.artifact_id,
      artifact!.source_run_id,
      "Reject",
      "Novelty insufficient after literature pass.",
    );

    const stored = workspace.latest_idea_review(result.run.thread_id);
    expect(stored?.decision).toBe("Reject");
    expect(workspace.thread_session_status(result.run.thread_id)).toBe("reviewed");

    const convergence = loadConvergenceForThread(workspace, result.run.thread_id);
    expect(convergence.can_freeze).toBe(false);
    expect(convergence.checks.find((c) => c.id === "A4")?.satisfied).toBe(false);
    expect(convergence.checks.find((c) => c.id === "A5")?.satisfied).toBe(true);
  });
});
