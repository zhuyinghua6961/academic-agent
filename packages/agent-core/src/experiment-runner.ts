import {AgentConfig} from "@academic-agent/config";
import {
  ArtifactManager,
  readExtendedPlan,
  writeExperimentBlueprintDraft,
} from "@academic-agent/harness";
import {createIdeaDiagnosisProvider, type IdeaDiagnosisProvider} from "@academic-agent/providers";
import {
  ExperimentBlueprintBodySchema,
  type ExperimentBlueprintBody,
  type ModeRun,
  type ProviderRequest,
  type SubagentReport,
} from "@academic-agent/schemas";
import {ProjectWorkspace} from "@academic-agent/workspace";

import {
  buildExperimentInitialMessages,
  runExperimentAgentLoop,
  type ExperimentDesignState,
} from "./experiment-loop.js";
import {
  extractToolCalls,
  toolResultSummary,
} from "./loop.js";
import {SubagentHarness, createHandoffPacket} from "./subagent-harness.js";
import {registerLiveSubagentInvokers} from "./subagent-invokers.js";
import {getExperimentTools, type ExperimentToolContext} from "./tooling.js";

export class ExperimentDesignRunner {
  readonly workspace: ProjectWorkspace;
  readonly artifactManager: ArtifactManager;
  readonly subagentHarness: SubagentHarness;
  readonly config: AgentConfig;
  readonly providerProfile;
  readonly provider: IdeaDiagnosisProvider;
  readonly maxIterations: number;

  constructor(workspace: ProjectWorkspace) {
    this.workspace = workspace;
    this.artifactManager = new ArtifactManager(workspace);
    this.config = AgentConfig.load(workspace.projectRoot);
    this.providerProfile = this.config.profile("planner");
    this.provider = createIdeaDiagnosisProvider(this.providerProfile, this.config.env);
    this.maxIterations = this.providerProfile.max_agent_iterations;
    this.subagentHarness = new SubagentHarness();
    registerLiveSubagentInvokers(this.subagentHarness, workspace.projectRoot, [
      "baseline_reviewer",
      "metric_reviewer",
      "experiment_ac",
    ]);
  }

  validateHandoff(threadId: string): {
    planArtifactId: string;
    body: import("@academic-agent/schemas").ResearchIdeaPlanBody;
  } {
    const planArtifact = this.workspace.latest_plan_artifact_for_thread(threadId);
    if (!planArtifact || planArtifact.artifact_type !== "ResearchIdeaPlan") {
      throw new Error("Frozen ResearchIdeaPlan required before Experiment Design.");
    }
    const [, plan] = readExtendedPlan(this.artifactManager, planArtifact.artifact_id);
    const body = plan.body;
    if (
      !body.main_claim.trim() ||
      !body.mechanism_sketch.trim() ||
      body.closest_related_work.length < 3 ||
      !body.compute_profile.trim() ||
      !body.data_profile.trim() ||
      !body.target_standard.trim()
    ) {
      throw new Error("Frozen plan missing handoff fields. Run /convergence to inspect gaps.");
    }
    return {planArtifactId: planArtifact.artifact_id, body};
  }

  async create_run(input: string, threadId: string): Promise<ModeRun> {
    this.validateHandoff(threadId);
    const run = this.workspace.create_run(threadId, input, "experiment_design");
    this.workspace.update_thread_workflow(threadId, {
      current_mode: "experiment_design",
      lifecycle_state: "experiment_design",
    });
    return run;
  }

  private buildToolRegistry(state: ExperimentDesignState) {
    const ctx: ExperimentToolContext = {
      runId: state.run_id,
      threadId: state.thread_id,
      getBlueprintBody: () => state.blueprint_body,
      setBlueprintBody: (body) => {
        state.blueprint_body = body;
      },
    };
    return getExperimentTools(this.workspace, ctx);
  }

  async agentNode(state: ExperimentDesignState): Promise<ExperimentDesignState> {
    const runId = state.run_id;
    const messages =
      state.messages.length > 0
        ? state.messages
        : buildExperimentInitialMessages(state.idea, state.plan_body, state.blueprint_body);
    const toolRegistry = this.buildToolRegistry(state);
    const tools = toolRegistry.getAllDefinitions();
    const providerRequest: ProviderRequest = this.provider.buildAgentRequest(messages, tools);
    this.workspace.add_event(runId, "provider.requested", {
      provider: providerRequest.provider,
      model: providerRequest.model,
      profile: providerRequest.profile,
      tool_count: tools.length,
    });
    const providerResponse = await this.provider.generateAgentResponse(providerRequest, tools);
    const output = providerResponse.output;
    const toolCalls = extractToolCalls(output);
    const assistantMsg: Record<string, unknown> = {
      role: "assistant",
      content: output.content,
    };
    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls.map((toolCall) => ({
        id: toolCall.call_id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        },
      }));
    }
    this.workspace.add_event(runId, "provider.responded", {
      provider: providerResponse.provider,
      model: providerResponse.model,
      has_tool_calls: toolCalls.length > 0,
      tool_count: toolCalls.length,
    });
    return {
      ...state,
      messages: [...messages, assistantMsg],
      tool_calls: toolCalls,
      iteration: state.iteration + 1,
    };
  }

  async toolsNode(state: ExperimentDesignState): Promise<ExperimentDesignState> {
    const runId = state.run_id;
    const threadId = state.thread_id;
    const toolRegistry = this.buildToolRegistry(state);
    const newMessages = [...state.messages];
    for (const toolCall of state.tool_calls) {
      const result = await toolRegistry.execute(toolCall.name, toolCall.arguments);
      const resultText = JSON.stringify(result);
      this.workspace.add_event(runId, "action.completed", {
        tool_name: toolCall.name,
        tool_call_id: toolCall.call_id,
        summary: toolResultSummary(toolCall.name, result),
      });
      this.workspace.add_message(
        threadId,
        "tool",
        resultText,
        runId,
        toolCall.call_id,
        toolCall.name,
        toolCall.arguments,
      );
      newMessages.push({
        role: "tool",
        tool_call_id: toolCall.call_id,
        name: toolCall.name,
        content: resultText,
      });
    }
    return {...state, messages: newMessages, tool_calls: []};
  }

  async execute_run(runId: string): Promise<void> {
    const run = this.workspace.get_run(runId);
    this.workspace.update_run(runId, "running");
    try {
      const {planArtifactId, body} = this.validateHandoff(run.thread_id);
      const initialBlueprint = ExperimentBlueprintBodySchema.parse({
        linked_plan_id: planArtifactId,
        main_claim: body.main_claim,
        claim_evidence_map: [],
        experiment_set: [],
        resources_must: [body.compute_profile, body.data_profile].filter(Boolean),
        reproducibility: body.reproducibility || "Release code and evaluation scripts.",
        review_notes: "",
      });
      let state: ExperimentDesignState = {
        run_id: runId,
        thread_id: run.thread_id,
        idea: run.input_idea,
        plan_artifact_id: planArtifactId,
        plan_body: body,
        messages: [],
        iteration: 0,
        tool_calls: [],
        blueprint_body: initialBlueprint,
      };

      state = await runExperimentAgentLoop(this, state);
      state.blueprint_body = ExperimentBlueprintBodySchema.parse(state.blueprint_body);

      const reviewRoles = ["baseline_reviewer", "metric_reviewer", "experiment_ac"] as const;
      const packets = reviewRoles.map((role) =>
        createHandoffPacket({
          threadId: run.thread_id,
          runId,
          role,
          task: `Review blueprint from ${role} perspective.`,
          payload: {blueprint: state.blueprint_body, plan_body: body},
          outputSchema: `${role}Report`,
        }),
      );
      this.workspace.add_event(runId, "agent.fanout.started", {
        roles: [...reviewRoles],
        count: packets.length,
      });
      const reports = await this.subagentHarness.invokeParallel(packets);
      for (const report of reports) {
        this.workspace.add_event(runId, "subagent.report", {
          role: report.role,
          status: report.status,
          packet_id: report.packet_id,
        });
        if (report.status === "completed" && report.role === "experiment_ac") {
          const output = report.output as {remaining_risks?: string[]};
          if (Array.isArray(output.remaining_risks)) {
            state.blueprint_body.review_notes = output.remaining_risks.join("; ");
          }
        }
      }
      const failedReview = reports.find((report) => report.status !== "completed");
      if (failedReview) {
        throw new Error(failedReview.error ?? `Subagent ${failedReview.role} failed`);
      }

      const previous = this.workspace.latest_artifact_for_thread(
        run.thread_id,
        "ExperimentBlueprintDraft",
      );
      const [artifact] = writeExperimentBlueprintDraft(
        this.artifactManager,
        runId,
        planArtifactId,
        state.blueprint_body,
        previous?.artifact_id ?? null,
      );
      this.workspace.update_run(runId, "completed", artifact.artifact_id);
      this.workspace.add_event(runId, "blueprint.draft.updated", {
        artifact_id: artifact.artifact_id,
        linked_plan_artifact_id: planArtifactId,
      });
      const assistant = [
        "我已通过 Experiment Design agent 循环与 reviewer fan-out 更新了 Blueprint 草稿。",
        "",
        `主 claim：${state.blueprint_body.main_claim}`,
        `实验数：${state.blueprint_body.experiment_set.length}`,
        "",
        "请用 /blueprint 查看详情，/meta-review-blueprint 后 /review-blueprint Freeze，再 /freeze-blueprint。",
      ].join("\n");
      this.workspace.add_message(run.thread_id, "assistant", assistant, runId);
    } catch (error) {
      this.workspace.update_run(runId, "failed", undefined, String(error));
      this.workspace.add_event(runId, "run.failed", {error: String(error)});
      throw error;
    }
  }

  async runAcMetaReview(
    threadId: string,
    runId: string,
    blueprintArtifactId: string,
  ): Promise<SubagentReport> {
    const packet = createHandoffPacket({
      threadId,
      runId,
      role: "experiment_ac",
      task: "Produce experiment AC meta-review with can_move_to_execution.",
      payload: {blueprint_artifact_id: blueprintArtifactId},
      outputSchema: "ExperimentMetaReview",
    });
    return this.subagentHarness.invoke(packet);
  }
}
