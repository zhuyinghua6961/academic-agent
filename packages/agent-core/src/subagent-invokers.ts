import {AgentConfig} from "@academic-agent/config";
import {
  createIdeaDiagnosisProvider,
  diagnosisFromText,
  AC_META_REVIEW_PROMPT,
  BASELINE_REVIEWER_PROMPT,
  CANDIDATE_REVIEWER_PROMPT,
  EXPERIMENT_ARCHITECT_PROMPT,
  METRIC_REVIEWER_PROMPT,
  NOVELTY_REVIEWER_PROMPT,
  PAPER_READER_PROMPT,
  type IdeaDiagnosisProvider,
} from "@academic-agent/providers";
import {ToolRegistry} from "@academic-agent/search";
import {
  CandidateIdeaReviewSchema,
  IdeaMetaReviewSchema,
  type HandoffPacket,
  type SubagentReport,
  type SubagentRole,
} from "@academic-agent/schemas";
import type {ProjectWorkspace} from "@academic-agent/workspace";

import {extractToolCalls} from "./loop.js";
import {createPaperReadingTools} from "./tooling.js";
import {createSubagentReport, type SubagentInvoker} from "./subagent-harness.js";

function profileForRole(role: SubagentRole): "reviewer" | "extractor" | "planner" {
  if (role === "paper_reader") return "extractor";
  if (role === "experiment_architect") return "planner";
  return "reviewer";
}

function promptForRole(role: SubagentRole): string {
  switch (role) {
    case "paper_reader":
      return PAPER_READER_PROMPT;
    case "novelty_reviewer":
      return NOVELTY_REVIEWER_PROMPT;
    case "candidate_reviewer":
      return CANDIDATE_REVIEWER_PROMPT;
    case "ac_meta_review":
      return AC_META_REVIEW_PROMPT;
    case "experiment_architect":
      return EXPERIMENT_ARCHITECT_PROMPT;
    case "baseline_reviewer":
      return BASELINE_REVIEWER_PROMPT;
    case "metric_reviewer":
      return METRIC_REVIEWER_PROMPT;
    case "research_mentor":
      return `You are the Research Mentor. Turn disagreements into evidence questions. Output JSON: {evidence_question, recommended_experiment, impact_level}.`;
    default:
      return "Respond with valid JSON for the requested output_schema.";
  }
}

function parseSubagentOutput(content: string): Record<string, unknown> {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    const diagnosis = diagnosisFromText(content);
    return diagnosis as unknown as Record<string, unknown>;
  }
}

async function invokeWithProvider(
  provider: IdeaDiagnosisProvider,
  packet: HandoffPacket,
): Promise<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [
    {role: "system", content: promptForRole(packet.role)},
    {
      role: "user",
      content: JSON.stringify({
        task: packet.task,
        output_schema: packet.output_schema,
        payload: packet.payload,
        source_refs: packet.source_refs,
      }),
    },
  ];
  const request = provider.buildAgentRequest(messages, []);
  const response = await provider.generateAgentResponse(request, []);
  return parseSubagentOutput(String(response.output.content ?? ""));
}

async function invokePaperReaderWithTools(
  provider: IdeaDiagnosisProvider,
  workspace: ProjectWorkspace,
  packet: HandoffPacket,
): Promise<Record<string, unknown>> {
  const registry = new ToolRegistry();
  for (const tool of createPaperReadingTools(workspace)) {
    registry.register(tool);
  }
  const tools = registry.getAllDefinitions();
  const messages: Array<Record<string, unknown>> = [
    {role: "system", content: promptForRole(packet.role)},
    {
      role: "user",
      content: JSON.stringify({
        task: packet.task,
        output_schema: packet.output_schema,
        payload: packet.payload,
        allowed_tools: packet.allowed_tools,
      }),
    },
  ];

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const request = provider.buildAgentRequest(messages, tools);
    const response = await provider.generateAgentResponse(request, tools);
    const toolCalls = extractToolCalls(response.output);
    if (toolCalls.length === 0) {
      return parseSubagentOutput(String(response.output.content ?? ""));
    }
    messages.push({
      role: "assistant",
      content: response.output.content ?? "",
      tool_calls: toolCalls.map((toolCall) => ({
        id: toolCall.call_id,
        type: "function",
        function: {name: toolCall.name, arguments: JSON.stringify(toolCall.arguments)},
      })),
    });
    for (const toolCall of toolCalls) {
      const result = await registry.execute(toolCall.name, toolCall.arguments);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.call_id,
        name: toolCall.name,
        content: JSON.stringify(result),
      });
    }
  }
  return {};
}

export function createLiveSubagentInvoker(
  projectRoot: string,
  role: SubagentRole,
  workspace?: ProjectWorkspace,
): SubagentInvoker {
  const config = AgentConfig.load(projectRoot);
  const profileName = profileForRole(role);
  const provider = createIdeaDiagnosisProvider(config.profile(profileName), config.env);
  return async (packet) => {
    try {
      const output =
        role === "paper_reader" && workspace
          ? await invokePaperReaderWithTools(provider, workspace, packet)
          : await invokeWithProvider(provider, packet);
      if (packet.role === "candidate_reviewer") {
        CandidateIdeaReviewSchema.parse(output);
      }
      if (packet.role === "ac_meta_review") {
        IdeaMetaReviewSchema.parse(output);
      }
      return createSubagentReport({packet, output});
    } catch (error) {
      return createSubagentReport({
        packet,
        output: {},
        status: "failed",
        error: String(error),
      });
    }
  };
}

export function registerLiveSubagentInvokers(
  harness: import("./subagent-harness.js").SubagentHarness,
  projectRoot: string,
  roles: SubagentRole[],
  workspace?: ProjectWorkspace,
): void {
  for (const role of roles) {
    harness.register(role, createLiveSubagentInvoker(projectRoot, role, workspace));
  }
}
