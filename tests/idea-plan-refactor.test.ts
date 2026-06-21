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

describe("idea plan coarse refactor path", () => {
  it("bumps idea_version and records branch on Major impact continuation", async () => {
    const root = mkdtempSync(join(tmpdir(), "idea-plan-refactor-"));
    tempRoots.push(root);
    writeConfig(root);
    enableRecordedProvider();
    const {ProjectWorkspace} = await import("@academic-agent/workspace");
    const workspace = new ProjectWorkspace(root);
    workspace.init();
    const runner = new IdeaPlanRunner(workspace);

    const first = await runner.run("做一个 academic agent，能自动读论文并提出研究 idea");
    expect(first.run.status).toBe("completed");
    expect(workspace.get_thread(first.run.thread_id).idea_version).toBe(1);

    const second = await runner.run(
      "完全不同方向：用强化学习控制扩散过程，而不是 agent 工作流",
      first.run.thread_id,
    );
    expect(second.run.status).toBe("completed");

    const thread = workspace.get_thread(first.run.thread_id);
    expect(thread.idea_version).toBe(2);
    expect(thread.impact_level).toBe("Major");

    const branchEvents = workspace
      .list_events(second.run.run_id)
      .filter((event) => event.event_type === "idea.version.branch");
    expect(branchEvents.length).toBeGreaterThan(0);
    expect(branchEvents[0]?.payload?.previous_artifact_id).toBeTruthy();
  });
});
