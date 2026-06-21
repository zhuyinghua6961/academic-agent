import type {
  ExperimentBlueprintBody,
  ResearchIdeaPlanBody,
  ToolCall,
} from "@academic-agent/schemas";

import type {ExperimentDesignRunner} from "./experiment-runner.js";

export type ExperimentDesignState = {
  run_id: string;
  thread_id: string;
  idea: string;
  plan_artifact_id: string;
  plan_body: ResearchIdeaPlanBody;
  messages: Array<Record<string, unknown>>;
  iteration: number;
  tool_calls: ToolCall[];
  blueprint_body: ExperimentBlueprintBody;
};

export function buildExperimentInitialMessages(
  idea: string,
  planBody: ResearchIdeaPlanBody,
  blueprint: ExperimentBlueprintBody,
): Array<Record<string, unknown>> {
  return [
    {
      role: "system",
      content:
        "You are the Experiment Design planner. Build claim-evidence map and must-have experiments from the frozen ResearchIdeaPlan. Use update_blueprint_body to persist structured updates before finishing.",
    },
    {
      role: "user",
      content: JSON.stringify({
        user_input: idea,
        frozen_plan: planBody,
        current_blueprint: blueprint,
      }),
    },
  ];
}

export async function runExperimentAgentLoop(
  runner: ExperimentDesignRunner,
  state: ExperimentDesignState,
): Promise<ExperimentDesignState> {
  let current = state;
  while (true) {
    current = await runner.agentNode(current);
    if (current.iteration >= runner.maxIterations) {
      break;
    }
    if (current.tool_calls.length > 0) {
      current = await runner.toolsNode(current);
      continue;
    }
    break;
  }
  return current;
}
