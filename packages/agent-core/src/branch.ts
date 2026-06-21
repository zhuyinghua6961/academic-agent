import fs from "node:fs";
import path from "node:path";

import type {ProjectWorkspace} from "@academic-agent/workspace";

export type IdeaVersionBranchRecord = {
  parent_thread_id: string;
  parent_artifact_id: string;
  impact_level: string;
  idea_version: number;
  created_at: string;
};

function branchPath(workspace: ProjectWorkspace, threadId: string): string {
  const dir = path.join(workspace.workspaceDir, "thread-state");
  fs.mkdirSync(dir, {recursive: true});
  return path.join(dir, `${threadId}.branch.json`);
}

export function recordIdeaVersionBranch(
  workspace: ProjectWorkspace,
  threadId: string,
  record: IdeaVersionBranchRecord,
): void {
  fs.writeFileSync(branchPath(workspace, threadId), JSON.stringify(record, null, 2) + "\n", "utf8");
}

export function readIdeaVersionBranch(
  workspace: ProjectWorkspace,
  threadId: string,
): IdeaVersionBranchRecord | null {
  const file = branchPath(workspace, threadId);
  if (!fs.existsSync(file)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as IdeaVersionBranchRecord;
}

export function createVersionBranchThread(
  workspace: ProjectWorkspace,
  parentThreadId: string,
  previousArtifactId: string,
  impactLevel: string,
  ideaVersion: number,
): string {
  const parent = workspace.get_thread(parentThreadId);
  const branch = workspace.create_thread(null, `${parent.name ?? "Idea"} v${ideaVersion}`);
  recordIdeaVersionBranch(workspace, branch.thread_id, {
    parent_thread_id: parentThreadId,
    parent_artifact_id: previousArtifactId,
    impact_level: impactLevel,
    idea_version: ideaVersion,
    created_at: new Date().toISOString(),
  });
  workspace.update_thread_workflow(branch.thread_id, {
    idea_version: ideaVersion,
    impact_level: impactLevel as import("@academic-agent/schemas").ImpactLevel,
    lifecycle_state: "idea_understanding",
  });
  return branch.thread_id;
}
