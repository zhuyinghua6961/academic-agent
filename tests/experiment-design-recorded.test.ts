import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";
import {ExperimentDesignRunner} from "@academic-agent/agent-core";
import {
  ArtifactManager,
  defaultPlanBody,
  freezeExtendedResearchIdeaPlan,
  writeExtendedResearchIdeaDraft,
} from "@academic-agent/harness";
import type {ContextPacket, Diagnosis} from "@academic-agent/schemas";
import {ProjectWorkspace} from "@academic-agent/workspace";

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
    ].join("\n"),
    "utf8",
  );
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

describe("experiment design recorded run", () => {
  it("runs after frozen plan with architect subagent", async () => {
    const root = mkdtempSync(join(tmpdir(), "exp-design-recorded-"));
    tempRoots.push(root);
    writeConfig(root);
    process.env.ACADEMIC_AGENT_RECORDED_PROVIDER = "1";
    process.env.ACADEMIC_AGENT_RECORDINGS_DIR = join(testDir, "recordings", "experiment-design");
    process.env.ACADEMIC_AGENT_ENABLE_LIVE_PROVIDERS = "1";
    process.env.TEST_KEY = "test-key";
    const workspace = new ProjectWorkspace(root);
    workspace.init();
    const thread = workspace.create_thread();
    const run = workspace.create_run(thread.thread_id, "test idea");
    const manager = new ArtifactManager(workspace);
    const diagnosis: Diagnosis = {
      problem: "p",
      gap: "g",
      candidate_mechanism: "m",
      evidence_needed: ["e"],
      main_uncertainty: "u",
      clarifying_questions: [],
    };
    const context: ContextPacket = {
      context_id: "ctx_test",
      mode: "idea_plan",
      task: "idea_plan",
      idea: "test",
      relevant_artifacts: [],
      constraints: [],
      source_refs: [],
      excluded_context_summary: "none",
      created_at: run.created_at,
    };
    const body = defaultPlanBody();
    body.main_claim = "Main claim";
    body.mechanism_sketch = "Mechanism";
    body.compute_profile = "1x GPU";
    body.data_profile = "public dataset";
    body.target_standard = "NeurIPS";
    body.closest_related_work = [
      {title: "A", status: "published", mechanism: "", claim: "", evidence: "", gap_for_us: "", novelty_risk: ""},
      {title: "B", status: "published", mechanism: "", claim: "", evidence: "", gap_for_us: "", novelty_risk: ""},
      {title: "C", status: "published", mechanism: "", claim: "", evidence: "", gap_for_us: "", novelty_risk: ""},
    ];
    const [draftMeta, draft] = writeExtendedResearchIdeaDraft(
      manager,
      run.run_id,
      diagnosis,
      context,
      [],
      body,
    );
    freezeExtendedResearchIdeaPlan(manager, draftMeta, draft);
    const runner = new ExperimentDesignRunner(workspace);
    const expRun = await runner.create_run("design experiments", thread.thread_id);
    await runner.execute_run(expRun.run_id);
    const blueprint = workspace.latest_artifact_for_thread(thread.thread_id, "ExperimentBlueprintDraft");
    expect(blueprint).not.toBeNull();
  });
});
