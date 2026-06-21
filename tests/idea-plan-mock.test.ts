import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {IdeaPlanRunner} from "@academic-agent/agent-core";
import {ProjectWorkspace} from "@academic-agent/workspace";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, {recursive: true, force: true});
  }
});

describe("idea plan mock run", () => {
  it("completes a run with mock provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "academic-agent-run-"));
    tempRoots.push(root);
    process.env.ACADEMIC_AGENT_ALLOW_MOCK = "1";
    const workspace = new ProjectWorkspace(root);
    const runner = new IdeaPlanRunner(workspace);
    const result = await runner.run("图像生成模型，文生图");
    expect(result.run.status).toBe("completed");
    expect(result.artifact.artifact_type).toBe("ResearchIdeaPlanDraft");
    expect(result.draft.diagnosis.problem.length).toBeGreaterThan(0);
    delete process.env.ACADEMIC_AGENT_ALLOW_MOCK;
  });
});
