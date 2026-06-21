import {IdeaPlanRunner} from "./runner.js";
import {ExperimentDesignRunner} from "./experiment-runner.js";
import type {ProjectWorkspace} from "@academic-agent/workspace";

export type ModeRunner = IdeaPlanRunner | ExperimentDesignRunner;

export function resolveModeRunner(workspace: ProjectWorkspace, threadId: string): ModeRunner {
  const thread = workspace.get_thread(threadId);
  if (thread.current_mode === "experiment_design") {
    return new ExperimentDesignRunner(workspace);
  }
  return new IdeaPlanRunner(workspace);
}

export function modeForThread(workspace: ProjectWorkspace, threadId: string): "idea_plan" | "experiment_design" {
  return workspace.get_thread(threadId).current_mode ?? "idea_plan";
}
