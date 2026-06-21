import {AgentConfig} from "@academic-agent/config";
import {
  ArtifactManager,
  CacheManager,
  ContextBuilder,
  MemoryManager,
  TraceRecorder,
  defaultPlanBody,
  readExtendedDraft,
  readExtendedPlan,
  writeExtendedResearchIdeaDraft,
  writeDisagreementLog,
  writeIdeaMetaReview,
} from "@academic-agent/harness";
import {
  ProviderError,
  createIdeaDiagnosisProvider,
  diagnosisFromText,
  type IdeaDiagnosisProvider,
} from "@academic-agent/providers";
import {createDefaultSearchEngine, type ToolRegistry} from "@academic-agent/search";
import {
  SearchResponseSchema,
  type ConversationSummary,
  type CreateIdeaPlanRunResponse,
  type Diagnosis,
  type ModeRun,
  type ProviderRequest,
  type ProviderResponse,
  type ResearchIdeaPlanBody,
  type ThreadMessage,
  utcNow,
} from "@academic-agent/schemas";
import {ProjectWorkspace} from "@academic-agent/workspace";

import {getExtendedTools, type PlanToolContext} from "./tooling.js";
import {loadConvergenceForThread} from "./convergence.js";
import {classifyImpact} from "./impact.js";
import {detectPlanIntent} from "./intent.js";
import {recordIdeaVersionBranch} from "./branch.js";
import {detectUserDisagreementLLM} from "./debate.js";
import {
  mergeSearchResultIntoClosestWork,
  paperTitlesNeedingReading,
  runAfterPaperSearchPipeline,
} from "./literature-pipeline.js";
import {nextLifecycleState, resumeLifecycleState, shouldPauseWorkflow} from "./lifecycle.js";
import {
  canPaperSearch,
  createSearchBudgetState,
  paperKey,
  updateSearchBudgetFromResponse,
} from "./search-budget.js";
import {
  SubagentHarness,
  createHandoffPacket,
} from "./subagent-harness.js";
import {registerLiveSubagentInvokers} from "./subagent-invokers.js";

import {
  buildArtifactContext,
  buildConversationSummary,
  buildHistoryContext,
  buildInitialMessages,
  buildFinalSynthesisMessages,
  cleanSummaryText,
  conversationSummarySystemPrompt,
  conversationSummaryUserPrompt,
  type HistoryContextPacket,
} from "./context.js";
import {emitActivity} from "./activity-events.js";
import {
  assistantSummary,
  extractToolCalls,
  fallbackTitle,
  fallbackTitleFromMessages,
  isPlaceholderTitle,
  languageFromText,
  providerResponseToRecord,
  runAgentLoop,
  streamChunks,
  toolDecisionMessage,
  toolObservationMessage,
  toolResultSummary,
  toolStartMessage,
  type IdeaPlanState,
} from "./loop.js";

export class RunCancelled extends Error {
  constructor(message = "Run cancelled by user") {
    super(message);
    this.name = "RunCancelled";
  }
}

export class IdeaPlanRunner {
  readonly workspace: ProjectWorkspace;
  readonly contextBuilder = new ContextBuilder();
  readonly memoryManager: MemoryManager;
  readonly cacheManager: CacheManager;
  readonly traceRecorder: TraceRecorder;
  readonly artifactManager: ArtifactManager;
  readonly config: AgentConfig;
  readonly providerProfile;
  readonly provider: IdeaDiagnosisProvider;
  readonly maxIterations: number;
  readonly subagentHarness: SubagentHarness;

  constructor(workspace: ProjectWorkspace) {
    this.workspace = workspace;
    this.memoryManager = new MemoryManager(workspace);
    this.cacheManager = new CacheManager(workspace);
    this.traceRecorder = new TraceRecorder(workspace);
    this.artifactManager = new ArtifactManager(workspace);
    this.config = AgentConfig.load(workspace.projectRoot);
    this.providerProfile = this.config.profile("planner");
    this.provider = createIdeaDiagnosisProvider(this.providerProfile, this.config.env);
    this.maxIterations = this.providerProfile.max_agent_iterations;
    this.subagentHarness = new SubagentHarness();
    registerLiveSubagentInvokers(this.subagentHarness, workspace.projectRoot, [
      "paper_reader",
      "novelty_reviewer",
      "research_mentor",
      "candidate_reviewer",
      "ac_meta_review",
    ], workspace);
  }

  private loadThreadPlanBody(threadId: string): ResearchIdeaPlanBody {
    const artifact = this.workspace.latest_plan_artifact_for_thread(threadId);
    if (!artifact) {
      return defaultPlanBody();
    }
    try {
      if (artifact.artifact_type === "ResearchIdeaPlan") {
        const [, plan] = readExtendedPlan(this.artifactManager, artifact.artifact_id);
        return plan.body;
      }
      const [, draft] = readExtendedDraft(this.artifactManager, artifact.artifact_id);
      return draft.body;
    } catch {
      return defaultPlanBody();
    }
  }

  private buildToolRegistry(state: IdeaPlanState) {
    const seenKeys = new Set(state.seen_paper_keys);
    const humanRead = new Set(state.human_read_papers);
    const planCtx: PlanToolContext = {
      workspace: this.workspace,
      artifactManager: this.artifactManager,
      runId: state.run_id,
      threadId: state.thread_id,
      getPlanBody: () => state.plan_body,
      setPlanBody: (body) => {
        state.plan_body = body;
      },
      humanReadPapers: humanRead,
    };
    const registry = getExtendedTools(this.workspace, planCtx);
    if (!canPaperSearch(state.search_budget)) {
      return registry.withoutTool("paper_search");
    }
    return registry;
  }

  async create_run(idea: string, threadId: string | null = null): Promise<ModeRun> {
    this.workspace.init();
    this.memoryManager.ensure_memory_entrypoint();
    const thread = this.workspace.create_thread(threadId);
    const run = this.workspace.create_run(thread.thread_id, idea);
    this.workspace.add_message(thread.thread_id, "user", idea, run.run_id);
    this.workspace.add_event(run.run_id, "run.created", {
      mode: run.mode,
      thread_id: run.thread_id,
    });
    return run;
  }

  async execute_run(runId: string): Promise<CreateIdeaPlanRunResponse> {
    const run = this.workspace.get_run(runId);
    if (run.status !== "created") {
      throw new Error(`Run ${runId} is not executable from status ${run.status}`);
    }

    this.workspace.update_run(run.run_id, "running");
    this.workspace.add_event(run.run_id, "run.running", {});
    const ideaPreview =
      run.input_idea.length > 72 ? `${run.input_idea.slice(0, 69).trimEnd()}...` : run.input_idea;
    emitActivity(
      this.workspace,
      run.run_id,
      "activity.started",
      "planning",
      `我已收到：「${ideaPreview}」`,
    );

    const history = this.workspace
      .list_messages(run.thread_id)
      .filter((message) => message.run_id !== runId);

    let threadAtStart = this.workspace.get_thread(run.thread_id);
    if (threadAtStart.lifecycle_state === "paused") {
      const resumeConvergence = loadConvergenceForThread(this.workspace, run.thread_id);
      const resumed = resumeLifecycleState("paused", resumeConvergence);
      this.workspace.update_thread_workflow(run.thread_id, {lifecycle_state: resumed});
      this.workspace.add_event(run.run_id, "plan.lifecycle.resume", {to: resumed});
      threadAtStart = this.workspace.get_thread(run.thread_id);
    }

    const intent = detectPlanIntent(run.input_idea, history.length > 0);
    if (history.length === 0) {
      this.workspace.update_thread_workflow(run.thread_id, {
        lifecycle_state:
          intent === "lightweight_diagnosis" ? "lightweight_diagnosis" : "idea_understanding",
      });
    } else {
      const priorBody = this.loadThreadPlanBody(run.thread_id);
      try {
        const impact = await classifyImpact(
          this.workspace.projectRoot,
          priorBody.main_claim || run.input_idea,
          run.input_idea,
        );
        const thread = this.workspace.get_thread(run.thread_id);
        if (impact === "Major" || impact === "Fatal") {
          const previousDraft = this.workspace.latest_plan_artifact_for_thread(run.thread_id);
          this.workspace.update_thread_workflow(run.thread_id, {
            impact_level: impact,
            idea_version: (thread.idea_version ?? 1) + 1,
          });
          if (previousDraft) {
            recordIdeaVersionBranch(this.workspace, run.thread_id, {
              parent_thread_id: run.thread_id,
              parent_artifact_id: previousDraft.artifact_id,
              impact_level: impact,
              idea_version: (thread.idea_version ?? 1) + 1,
              created_at: utcNow(),
            });
            this.workspace.add_event(run.run_id, "idea.version.branch", {
              previous_artifact_id: previousDraft.artifact_id,
              impact_level: impact,
              idea_version: (thread.idea_version ?? 1) + 1,
            });
          }
        } else if (impact !== "None") {
          this.workspace.update_thread_workflow(run.thread_id, {impact_level: impact});
        }
      } catch (error) {
        this.workspace.add_event(run.run_id, "impact.classify_failed", {error: String(error)});
      }
    }

    const artifactContext = buildArtifactContext(
      this.workspace,
      this.artifactManager,
      run.thread_id,
      this.config.context_compaction,
      this.providerProfile.model,
      this.providerProfile.max_output_tokens,
      run.input_idea,
    );
    const draftHistoryContext = buildHistoryContext(history, {
      latestInput: run.input_idea,
      compactionConfig: this.config.context_compaction,
      model: this.providerProfile.model,
      maxOutputTokens: this.providerProfile.max_output_tokens,
      artifactContext,
    });

    let persistentSummary: ConversationSummary | null = null;
    if (draftHistoryContext.compacted) {
      persistentSummary = buildConversationSummary(
        run.thread_id,
        history,
        draftHistoryContext,
        this.memoryManager.read_conversation_summary(run.thread_id),
      );
      persistentSummary = await this.maybeRefineConversationSummary(
        run.run_id,
        persistentSummary,
        draftHistoryContext,
      );
      persistentSummary = this.memoryManager.write_conversation_summary(persistentSummary);
      this.workspace.add_event(run.run_id, "memory.summary.updated", {
        summary_id: persistentSummary.summary_id,
        thread_id: persistentSummary.thread_id,
        covered_message_count: persistentSummary.covered_message_count,
        covered_until_ordinal: persistentSummary.covered_until_ordinal,
        summary_source: persistentSummary.summary_source,
        provider: persistentSummary.provider,
        model: persistentSummary.model,
        path: persistentSummary.markdown_path,
        metadata_path: persistentSummary.metadata_path,
      });
    } else {
      persistentSummary = this.memoryManager.read_conversation_summary(run.thread_id);
    }

    const historyContext = buildHistoryContext(history, {
      persistentSummary,
      latestInput: run.input_idea,
      compactionConfig: this.config.context_compaction,
      model: this.providerProfile.model,
      maxOutputTokens: this.providerProfile.max_output_tokens,
      artifactContext,
    });
    this.workspace.add_event(run.run_id, "context.compacted", {
      compacted: historyContext.compacted,
      total_message_count: historyContext.total_message_count,
      older_message_count: historyContext.older_message_count,
      recent_message_count: historyContext.recent_message_count,
      important_message_count: historyContext.important_message_count,
      source_refs: historyContext.source_refs,
      artifact_source_refs: historyContext.artifact_source_refs,
      important_source_refs: historyContext.important_source_refs,
      excluded_context_summary: historyContext.excluded_context_summary,
      compact_reason: historyContext.compact_reason,
      context_focus: historyContext.context_focus,
      estimated_history_tokens: historyContext.estimated_history_tokens,
      history_token_budget: historyContext.history_token_budget,
      compact_threshold_tokens: historyContext.compact_threshold_tokens,
      context_window_tokens: historyContext.context_window_tokens,
      recent_token_budget: historyContext.recent_token_budget,
      important_token_budget: historyContext.important_token_budget,
      summary_token_budget: historyContext.summary_token_budget,
      artifact_context_tokens: historyContext.artifact_context_tokens,
      artifact_token_budget: historyContext.artifact_token_budget,
      persistent_summary_id: historyContext.persistent_summary_id,
      persistent_summary_path: historyContext.persistent_summary_path,
      persistent_summary_covered_until_ordinal:
        historyContext.persistent_summary_covered_until_ordinal,
    });
    if (historyContext.compacted) {
      emitActivity(
        this.workspace,
        run.run_id,
        "activity.completed",
        "context",
        "历史对话已智能 compact：按 token 预算保留最近原文和高价值旧片段，长期摘要写入 memory，完整记录仍在本地 trace。",
        {
          total_message_count: historyContext.total_message_count,
          older_message_count: historyContext.older_message_count,
          recent_message_count: historyContext.recent_message_count,
          important_message_count: historyContext.important_message_count,
          context_focus: historyContext.context_focus,
          compact_reason: historyContext.compact_reason,
        },
      );
    }

    const initialState: IdeaPlanState = {
      idea: run.input_idea,
      run_id: run.run_id,
      thread_id: run.thread_id,
      messages: buildInitialMessages(run.input_idea, historyContext),
      iteration: 0,
      tool_calls: [],
      history_context: historyContext,
      plan_body: this.loadThreadPlanBody(run.thread_id),
      search_budget: createSearchBudgetState(run.run_id),
      seen_paper_keys: [],
      human_read_papers: [],
    };

    const readingRequest = this.workspace.get_reading_request(run.thread_id);
    if (readingRequest) {
      await this.runPaperReaderSession(initialState, readingRequest);
      this.workspace.clear_reading_request(run.thread_id);
    }

    try {
      const result = await runAgentLoop(this, initialState);
      this.raiseIfCancelled(run.run_id);
      const artifactId = result.artifact_id;
      if (!artifactId) {
        throw new Error(`Run ${run.run_id} completed without artifact_id`);
      }
      const completed = this.workspace.update_run(run.run_id, "completed", artifactId);
      this.workspace.add_event(run.run_id, "run.completed", {
        artifact_id: artifactId,
        trace_id: result.trace_id,
      });
      const metadata = this.workspace.get_artifact_metadata(artifactId);
      const draft = result.draft;
      if (!draft) {
        throw new Error(`Run ${run.run_id} completed without draft`);
      }
      return {
        run: completed,
        artifact: metadata,
        draft: draft as CreateIdeaPlanRunResponse["draft"],
      };
    } catch (error) {
      if (error instanceof RunCancelled) {
        if (this.workspace.get_run(run.run_id).status !== "cancelled") {
          this.workspace.update_run(run.run_id, "cancelled", undefined, String(error));
          this.workspace.add_event(run.run_id, "run.cancelled", {reason: String(error)});
        }
        throw error;
      }
      if (this.workspace.get_run(run.run_id).status === "cancelled") {
        throw new RunCancelled("Run cancelled by user");
      }
      const failed = this.workspace.update_run(run.run_id, "failed", undefined, String(error));
      this.workspace.add_event(run.run_id, "run.failed", {error: String(error)});
      throw new Error(`Idea plan run failed: ${failed.run_id}`, {cause: error});
    }
  }

  async run(idea: string, threadId: string | null = null): Promise<CreateIdeaPlanRunResponse> {
    const created = await this.create_run(idea, threadId);
    return this.execute_run(created.run_id);
  }

  async agentNode(state: IdeaPlanState): Promise<IdeaPlanState> {
    const runId = state.run_id;
    const iteration = state.iteration;

    if (iteration >= this.maxIterations) {
      return state;
    }

    this.raiseIfCancelled(runId);

    emitActivity(
      this.workspace,
      runId,
      iteration === 0 ? "activity.updated" : "activity.updated",
      "planning",
      iteration === 0
        ? "我在整理上下文、近邻文献需求和下一步动作。"
        : "我在结合工具观察结果更新诊断。",
      {iteration},
    );

    const messages = state.messages;
    const tools = this.buildToolRegistry(state).getAllDefinitions();
    const providerRequest = this.provider.buildAgentRequest(messages, tools);

    this.workspace.add_event(runId, "provider.requested", {
      provider: providerRequest.provider,
      model: providerRequest.model,
      profile: providerRequest.profile,
      request_id: providerRequest.request_id,
      live: true,
      iteration,
      reasoning_effort: this.providerProfile.reasoning_effort,
      reasoning_summary: this.providerProfile.reasoning_summary,
    });

    const cachedResponse = this.cacheManager.get_provider_response(providerRequest);
    const cacheHit = cachedResponse !== null;
    let providerResponse: ProviderResponse;
    if (cachedResponse !== null) {
      providerResponse = {
        ...cachedResponse,
        request_id: providerRequest.request_id,
        response_id: cachedResponse.response_id,
        cached: true,
      };
      this.workspace.add_event(runId, "cache.hit", {
        cache_type: "provider_response",
        provider: providerRequest.provider,
        model: providerRequest.model,
        profile: providerRequest.profile,
        cached_tokens: Number(cachedResponse.usage?.cache_read_tokens ?? 0),
      });
      emitActivity(this.workspace,
        runId,
        "activity.completed",
        "thinking",
        "命中本地 app cache，我复用上一轮相同输入下的模型结果。",
        {provider: providerRequest.provider, model: providerRequest.model},
      );
    } else {
      emitActivity(this.workspace,
        runId,
        "activity.started",
        "thinking",
        "我正在让 planner 生成诊断或决定是否调用检索工具。",
        {provider: providerRequest.provider, model: providerRequest.model},
      );
      providerResponse = await this.generateAgentResponse(runId, providerRequest, tools);
      this.cacheManager.store_provider_response(providerRequest, providerResponse);
      this.workspace.add_event(runId, "cache.stored", {
        cache_type: "provider_response",
        provider: providerRequest.provider,
        model: providerRequest.model,
        profile: providerRequest.profile,
      });
      emitActivity(this.workspace,
        runId,
        "activity.completed",
        "thinking",
        "planner 已返回结果，我开始检查是否需要工具调用。",
        {provider: providerResponse.provider, model: providerResponse.model},
      );
    }
    this.raiseIfCancelled(runId);

    const output = providerResponse.output;
    const content = output.content;
    const reasoningContent = output.reasoning_content;
    const toolCalls = extractToolCalls(output);
    const finishReason = String(output.finish_reason ?? "stop");

    const assistantMsg: Record<string, unknown> = {
      role: "assistant",
      content,
    };
    if (reasoningContent) {
      assistantMsg.reasoning_content = reasoningContent;
    }
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

    const newMessages = [...messages, assistantMsg];
    this.workspace.add_event(runId, "provider.responded", {
      provider: providerResponse.provider,
      model: providerResponse.model,
      response_id: providerResponse.response_id,
      has_tool_calls: toolCalls.length > 0,
      tool_count: toolCalls.length,
      finish_reason: finishReason,
      usage: providerResponse.usage,
      cached: providerResponse.cached,
      cache_hit: cacheHit,
    });

    if (toolCalls.length > 0) {
      emitActivity(this.workspace, runId, "activity.updated", "deciding", toolDecisionMessage(toolCalls), {
        tool_names: toolCalls.map((toolCall) => toolCall.name),
      });
    } else {
      emitActivity(this.workspace,
        runId,
        "activity.completed",
        "deciding",
        "这一轮不需要继续调用工具，准备收束成五字段诊断。",
        {finish_reason: finishReason},
      );
    }

    return {
      ...state,
      messages: newMessages,
      tool_calls: toolCalls,
      iteration: iteration + 1,
      provider_response: providerResponseToRecord(providerResponse),
    };
  }

  async toolsNode(state: IdeaPlanState): Promise<IdeaPlanState> {
    const runId = state.run_id;
    const threadId = state.thread_id;
    const toolCalls = state.tool_calls;
    const newMessages = [...state.messages];
    const toolRegistry = this.buildToolRegistry(state);
    const seenKeys = new Set(state.seen_paper_keys);

    for (const toolCall of toolCalls) {
      const callId = toolCall.call_id;
      const toolMessage = toolStartMessage(toolCall.name, toolCall.arguments);
      emitActivity(
        this.workspace,
        runId,
        "activity.started",
        toolCall.name === "paper_search" || toolCall.name === "web_search" ? "searching" : "acting",
        toolMessage,
        {
          tool_name: toolCall.name,
          tool_call_id: callId,
          arguments: toolCall.arguments,
        },
      );

      const result = await toolRegistry.execute(toolCall.name, toolCall.arguments);
      const resultText = JSON.stringify(result);
      const resultSummary = toolResultSummary(toolCall.name, result);
      const resultError = result.error;
      const resultItems = result.results;
      const hasResults = Array.isArray(resultItems) && resultItems.length > 0;
      const isError = Boolean(resultError) && !hasResults;

      if (toolCall.name === "paper_search") {
        emitActivity(
          this.workspace,
          runId,
          "activity.completed",
          "observing",
          toolObservationMessage(toolCall.name, resultSummary, isError),
          {
            tool_name: toolCall.name,
            tool_call_id: callId,
            ...resultSummary,
          },
        );
        try {
          let searchResponse = SearchResponseSchema.parse(result);
          searchResponse = await runAfterPaperSearchPipeline(
            this.workspace,
            this.artifactManager,
            this.subagentHarness,
            {
              runId,
              threadId,
              planBody: state.plan_body,
              searchResponse,
            },
          );
          state.search_budget = updateSearchBudgetFromResponse(
            state.search_budget,
            searchResponse,
            seenKeys,
          );
          for (const item of searchResponse.results) {
            mergeSearchResultIntoClosestWork(state.plan_body, item);
          }
          const [artifact] = this.artifactManager.write_paper_search_evidence(
            runId,
            searchResponse,
          );
          const topTitles = searchResponse.results
            .slice(0, 3)
            .map((item) => String(item.title ?? "").trim())
            .filter(Boolean);
          this.workspace.add_event(runId, "paper_search.evidence.created", {
            artifact_id: artifact.artifact_id,
            artifact_type: artifact.artifact_type,
            path: artifact.path,
            metadata_path: artifact.metadata_path,
            query: searchResponse.query,
            result_count: searchResponse.results.length,
            top_titles: topTitles,
          });
        } catch (error) {
          this.workspace.add_event(runId, "paper_search.evidence.failed", {
            error: String(error),
          });
        }
      }

      this.workspace.add_message(
        threadId,
        "tool",
        resultText,
        runId,
        callId,
        toolCall.name,
        toolCall.arguments,
      );

      newMessages.push({
        role: "tool",
        tool_call_id: callId,
        name: toolCall.name,
        content: resultText,
      });

      if (toolCall.name !== "paper_search") {
        emitActivity(
          this.workspace,
          runId,
          "activity.completed",
          "observing",
          toolObservationMessage(toolCall.name, resultSummary, isError),
          {
            tool_name: toolCall.name,
            tool_call_id: callId,
            ...resultSummary,
          },
        );
      }
    }

    return {
      ...state,
      messages: newMessages,
      tool_calls: [],
      seen_paper_keys: [...seenKeys],
      human_read_papers: [...state.human_read_papers],
    };
  }

  async finalizeNode(state: IdeaPlanState): Promise<IdeaPlanState> {
    const runId = state.run_id;
    const run = this.workspace.get_run(runId);
    const idea = state.idea;

    this.raiseIfCancelled(runId);

    let lastContent: string | null = null;
    for (const message of [...state.messages].reverse()) {
      if (message.role === "assistant" && message.content) {
        lastContent = String(message.content);
        break;
      }
    }

    let diagnosis: Diagnosis;
    try {
      diagnosis = diagnosisFromText(lastContent ?? "");
    } catch {
      diagnosis = await this.synthesizeFinalDiagnosis(state, idea);
    }

    const history = this.workspace
      .list_messages(run.thread_id)
      .filter((message) => message.run_id !== runId);
    const historyContext = state.history_context ?? ({} as HistoryContextPacket);

    const context = this.contextBuilder.build_for_idea(
      idea,
      historyContext.artifact_source_refs ?? [],
      historyContext.source_refs ?? [],
      historyContext.excluded_context_summary ?? "No prior context exclusions recorded.",
    );
    this.workspace.add_event(runId, "context.built", {
      context_id: context.context_id,
      source_refs: context.source_refs,
      excluded_context_summary: context.excluded_context_summary,
    });
    emitActivity(this.workspace,
      runId,
      "activity.completed",
      "context",
      "已构造本轮最小上下文包，准备写入会话诊断。",
      {context_id: context.context_id},
    );
    this.raiseIfCancelled(runId);

    const assistantContent = assistantSummary(
      diagnosis,
      history.length === 0,
      languageFromText(idea),
    );
    emitActivity(this.workspace,runId, "activity.started", "answering", "我开始把诊断流式输出给你。");
    this.workspace.add_event(runId, "assistant.reset", {reason: "final_answer"});
    await this.emitAssistantStream(runId, assistantContent);
    emitActivity(this.workspace,
      runId,
      "activity.completed",
      "answering",
      "五字段诊断已经输出完毕，接下来写入 artifact 和 trace。",
    );
    this.raiseIfCancelled(runId);

    this.workspace.add_message(run.thread_id, "assistant", assistantContent, runId);
    this.raiseIfCancelled(runId);

    const generatedTitle = await this.maybeGenerateThreadTitle(
      runId,
      run.thread_id,
      idea,
      diagnosis,
      history,
    );
    const previousArtifact = this.workspace.latest_artifact_for_thread(run.thread_id);
    const providerResponse = state.provider_response ?? {};

    const trace = this.traceRecorder.record(runId, "idea_plan_agent", {
      context,
      history_context: historyContext,
      provider_response: providerResponse,
      thread_messages: this.workspace.list_messages(run.thread_id),
      agent_iterations: state.iteration,
      provider_profile: this.providerProfile,
      generated_thread_title: generatedTitle,
      decision: previousArtifact
        ? "update ResearchIdeaPlanDraft session artifact"
        : "create ResearchIdeaPlanDraft artifact",
    });
    this.workspace.add_event(runId, "trace.recorded", {
      trace_id: trace.trace_id,
      trace_type: trace.trace_type,
      path: trace.path,
    });
    this.raiseIfCancelled(runId);

    const traceRefs = [...(previousArtifact?.trace_refs ?? []), trace.trace_id];
    const body = {...state.plan_body};
    body.main_claim = body.main_claim || diagnosis.candidate_mechanism;
    body.mechanism_sketch = body.mechanism_sketch || diagnosis.candidate_mechanism;
    body.falsification_condition = body.falsification_condition || diagnosis.main_uncertainty;
    body.why_non_trivial = body.why_non_trivial || diagnosis.gap;
    body.assumptions.to_verify = [
      ...new Set([...body.assumptions.to_verify, ...diagnosis.evidence_needed]),
    ];
    const [artifact, draft] = writeExtendedResearchIdeaDraft(
      this.artifactManager,
      runId,
      diagnosis,
      context,
      traceRefs,
      body,
      previousArtifact?.artifact_id ?? null,
    );
    const artifactEventType = previousArtifact ? "artifact.updated" : "artifact.created";
    this.workspace.add_event(runId, artifactEventType, {
      artifact_id: artifact.artifact_id,
      artifact_type: artifact.artifact_type,
      path: artifact.path,
      metadata_path: artifact.metadata_path,
    });
    this.refreshMemoryMap(runId);

    const convergence = loadConvergenceForThread(this.workspace, run.thread_id);
    const thread = this.workspace.get_thread(run.thread_id);
    const miniReviewCount = this.workspace.count_thread_artifacts(run.thread_id, "PaperMiniReview");
    const hookCount = this.workspace.count_thread_artifacts(run.thread_id, "InnovationHook");
    const humanReadCount = state.human_read_papers.length;
    const pause = shouldPauseWorkflow({
      convergence,
      searchBudgetExhausted: state.search_budget.budget_exhausted,
      miniReviewCount,
      humanReadCount,
    });
    const nextLifecycle = nextLifecycleState(thread.lifecycle_state ?? "lightweight_diagnosis", convergence, {
      miniReviewCount,
      hookCount,
      hasIntake: convergence.checks.find((c) => c.id === "L1")?.satisfied ?? false,
      paused: pause.paused,
    });
    if (pause.paused && pause.reason) {
      this.workspace.add_message(run.thread_id, "assistant", `${pause.reason} 线程已暂停。`, runId);
    }
    if (nextLifecycle !== thread.lifecycle_state) {
      this.workspace.update_thread_workflow(run.thread_id, {lifecycle_state: nextLifecycle});
      this.workspace.add_event(runId, "plan.lifecycle.transition", {
        from: thread.lifecycle_state,
        to: nextLifecycle,
      });
    }

    await this.runReviewPipeline(state, body, convergence, nextLifecycle, {
      miniReviewCount,
      hookCount,
    });

    if (await this.detectUserDisagreement(state.idea, body.main_claim)) {
      try {
        await this.runResearchMentor(state, body);
      } catch (error) {
        this.workspace.add_event(state.run_id, "research_mentor.failed", {error: String(error)});
      }
    }

    return {
      ...state,
      context: context as unknown as Record<string, unknown>,
      trace_id: trace.trace_id,
      artifact_id: artifact.artifact_id,
      draft: draft as unknown as Record<string, unknown>,
      diagnosis: diagnosis as unknown as Record<string, unknown>,
    };
  }

  private async generateAgentResponse(
    runId: string,
    providerRequest: ProviderRequest,
    tools: ReturnType<ToolRegistry["getAllDefinitions"]>,
  ): Promise<ProviderResponse> {
    const stream = this.provider.streamAgentResponse(providerRequest, tools);
    if (stream === null) {
      return this.provider.generateAgentResponse(providerRequest, tools);
    }

    this.workspace.add_event(runId, "provider.stream.started", {
      provider: providerRequest.provider,
      model: providerRequest.model,
      profile: providerRequest.profile,
    });
    emitActivity(this.workspace,
      runId,
      "activity.updated",
      "thinking",
      "planner 正在推理…",
      {provider: providerRequest.provider, model: providerRequest.model},
    );

    let chunks = 0;
    let reasoningChunks = 0;
    let toolCallDeltaChunks = 0;
    let finalResponse: ProviderResponse | null = null;
    try {
      for await (const chunk of stream) {
        this.raiseIfCancelled(runId);
        const chunkType = chunk.type;
        if (chunkType === "content_delta") {
          const delta = String(chunk.delta ?? "");
          if (!delta) {
            continue;
          }
          chunks += 1;
          continue;
        }
        if (chunkType === "reasoning_delta") {
          reasoningChunks += 1;
          continue;
        }
        if (chunkType === "tool_call_delta") {
          toolCallDeltaChunks += 1;
          continue;
        }
        if (chunkType === "completed" && chunk.response) {
          finalResponse = chunk.response;
        }
      }
    } catch (error) {
      if (error instanceof ProviderError) {
        this.workspace.add_event(runId, "provider.stream.fallback", {
          provider: providerRequest.provider,
          model: providerRequest.model,
          error: String(error),
        });
        emitActivity(this.workspace,
          runId,
          "activity.updated",
          "thinking",
          "planner 流式调用失败，我切换到非流式请求完成本轮诊断。",
          {provider: providerRequest.provider, model: providerRequest.model},
        );
        return this.provider.generateAgentResponse(providerRequest, tools);
      }
      throw error;
    }

    if (finalResponse === null) {
      throw new ProviderError("Provider stream ended without a completed response.");
    }

    this.workspace.add_event(runId, "provider.stream.completed", {
      provider: finalResponse.provider,
      model: finalResponse.model,
      response_id: finalResponse.response_id,
      chunks,
      reasoning_chunks_hidden: reasoningChunks,
      tool_call_delta_chunks: toolCallDeltaChunks,
    });
    return finalResponse;
  }

  private async synthesizeFinalDiagnosis(state: IdeaPlanState, idea: string): Promise<Diagnosis> {
    const runId = state.run_id;
    emitActivity(this.workspace,
      runId,
      "activity.updated",
      "synthesizing",
      "工具检索已结束，我正在强制收束为五字段诊断。",
    );
    const messages = buildFinalSynthesisMessages(
      idea,
      state.messages,
      state.history_context ?? {},
    );
    const request = this.provider.buildAgentRequest(messages, []);
    this.workspace.add_event(runId, "provider.requested", {
      provider: request.provider,
      model: request.model,
      profile: request.profile,
      request_id: request.request_id,
      live: true,
      phase: "final_synthesis",
    });
    try {
      let response = this.cacheManager.get_provider_response(request);
      if (response === null) {
        response = await this.provider.generateAgentResponse(request, []);
        this.cacheManager.store_provider_response(request, response);
      } else {
        response = {...response, request_id: request.request_id, cached: true};
      }
      this.workspace.add_event(runId, "provider.responded", {
        provider: response.provider,
        model: response.model,
        response_id: response.response_id,
        phase: "final_synthesis",
        usage: response.usage,
        cached: response.cached,
      });
      const content = String(response.output.content ?? "");
      const diagnosis = diagnosisFromText(content);
      emitActivity(this.workspace,
        runId,
        "activity.completed",
        "synthesizing",
        "已根据工具观察结果完成最终诊断收束。",
      );
      return diagnosis;
    } catch (error) {
      this.workspace.add_event(runId, "final_synthesis.failed", {error: String(error)});
      emitActivity(this.workspace,
        runId,
        "activity.completed",
        "synthesizing",
        "最终诊断收束失败，请检查 provider 配置后重试。",
      );
      throw error;
    }
  }

  private async runPaperReaderSession(
    state: IdeaPlanState,
    request: {mode: "quick" | "guided" | "exam"; paper_id: string; query?: string},
  ): Promise<void> {
    const packet = createHandoffPacket({
      threadId: state.thread_id,
      runId: state.run_id,
      role: "paper_reader",
      task: `Read paper in ${request.mode} mode and produce PaperReadingReport.`,
      payload: {paper_id: request.paper_id, query: request.query ?? "", mode: request.mode},
      outputSchema: "PaperReadingReport",
    });
    this.workspace.add_event(state.run_id, "subagent.handoff", {
      role: packet.role,
      packet_id: packet.packet_id,
      reading_mode: request.mode,
    });
    const report = await this.subagentHarness.invoke(packet);
    this.workspace.add_event(state.run_id, "subagent.report", {
      role: report.role,
      status: report.status,
      packet_id: report.packet_id,
    });
    if (report.status !== "completed") {
      return;
    }
    const output = report.output as {
      problem?: string;
      mechanism?: string;
      evidence?: string;
      limitation?: string;
    };
    const {writePaperMiniReview, markPaperHumanRead, findManifestEntryByPaperId} =
      await import("@academic-agent/harness");
    writePaperMiniReview(this.artifactManager, state.run_id, {
      source_run_id: state.run_id,
      paper_id: request.paper_id,
      title: request.paper_id,
      status: "unknown",
      summary: [output.problem, output.mechanism, output.evidence].filter(Boolean).join("\n"),
      strengths: output.evidence ? [String(output.evidence)] : [],
      weaknesses: output.limitation ? [String(output.limitation)] : [],
      questions: [],
      confidence: request.mode === "exam" ? "high" : "medium",
      innovation_hooks: [],
      novelty_risk_for_idea: String(output.limitation ?? ""),
    });
    if (findManifestEntryByPaperId(this.workspace, request.paper_id)) {
      markPaperHumanRead(this.workspace, request.paper_id);
    }
    state.human_read_papers.push(request.paper_id);
  }

  private shouldRunNoveltyReview(state: IdeaPlanState): boolean {
    const hooks = this.workspace.count_thread_artifacts(state.thread_id, "InnovationHook");
    const reviews = this.workspace.count_thread_artifacts(state.thread_id, "PaperMiniReview");
    return hooks < 1 && reviews >= 1;
  }

  private async runReviewPipeline(
    state: IdeaPlanState,
    body: ResearchIdeaPlanBody,
    convergence: ReturnType<typeof loadConvergenceForThread>,
    lifecycle: import("@academic-agent/schemas").LifecycleState,
    counts: {miniReviewCount: number; hookCount: number},
  ): Promise<void> {
    if (
      lifecycle === "human_agent_reading" ||
      (counts.miniReviewCount < 3 && body.closest_related_work.length > 0)
    ) {
      await this.autoSchedulePaperReading(state, body);
    }

    if (counts.hookCount < 1 && counts.miniReviewCount >= 1) {
      const {autoExtractInnovationHooks} = await import("./literature-pipeline.js");
      await autoExtractInnovationHooks(this.workspace, this.artifactManager, this.subagentHarness, {
        runId: state.run_id,
        threadId: state.thread_id,
        mainClaim: body.main_claim,
        planBody: body,
      });
    }

    const refreshed = loadConvergenceForThread(this.workspace, state.thread_id);
    const miniReviews = this.workspace.count_thread_artifacts(state.thread_id, "PaperMiniReview");
    if (
      miniReviews >= 3 &&
      refreshed.can_enter_candidate_review &&
      lifecycle === "candidate_idea_review"
    ) {
      await this.maybeRunCandidateReview(state, body);
    }

    if (this.shouldRunNoveltyReview(state)) {
      await this.runNoveltyReviewBatch(state, body);
    }
  }

  private async autoSchedulePaperReading(
    state: IdeaPlanState,
    body: ResearchIdeaPlanBody,
  ): Promise<void> {
    const targets = paperTitlesNeedingReading(
      this.workspace,
      state.thread_id,
      body.closest_related_work,
      3,
    );
    if (targets.length === 0) {
      return;
    }
    this.workspace.add_event(state.run_id, "agent.fanout.started", {
      phase: "auto_paper_reading",
      count: targets.length,
    });
    for (const paper of targets) {
      await this.runPaperReaderSession(state, {
        mode: "guided",
        paper_id: paper.paper_id ?? paper.title,
        query: paper.title,
      });
    }
    this.workspace.add_event(state.run_id, "agent.fanout.completed", {
      phase: "auto_paper_reading",
      count: targets.length,
    });
  }

  private async detectUserDisagreement(userMessage: string, agentClaim: string): Promise<boolean> {
    try {
      return await detectUserDisagreementLLM(this.workspace.projectRoot, userMessage, agentClaim);
    } catch {
      return false;
    }
  }

  async runResearchMentorForThread(
    threadId: string,
    runId: string,
    userMessage: string,
    agentClaim: string,
  ): Promise<void> {
    const state = {
      run_id: runId,
      thread_id: threadId,
      idea: userMessage,
    } as IdeaPlanState;
    await this.runResearchMentor(state, {main_claim: agentClaim} as ResearchIdeaPlanBody);
  }

  private async runNoveltyReviewBatch(
    state: IdeaPlanState,
    body: ResearchIdeaPlanBody,
  ): Promise<void> {
    const papers = body.closest_related_work.slice(0, 3);
    const packets = papers.map((paper) =>
      createHandoffPacket({
        threadId: state.thread_id,
        runId: state.run_id,
        role: "novelty_reviewer",
        task: `Assess novelty risk relative to ${paper.title}`,
        payload: {paper, main_claim: body.main_claim},
        outputSchema: "NoveltyReviewReport",
      }),
    );
    if (packets.length === 0) {
      return;
    }
    this.workspace.add_event(state.run_id, "agent.fanout.started", {
      roles: packets.map((packet) => packet.role),
      count: packets.length,
    });
    const reports = await this.subagentHarness.invokeParallel(packets);
    for (const report of reports) {
      this.workspace.add_event(state.run_id, "subagent.report", {
        role: report.role,
        status: report.status,
        packet_id: report.packet_id,
      });
    }
  }

  private async runResearchMentor(
    state: IdeaPlanState,
    body: ResearchIdeaPlanBody,
  ): Promise<void> {
    const packet = createHandoffPacket({
      threadId: state.thread_id,
      runId: state.run_id,
      role: "research_mentor",
      task: "Turn user disagreement into an evidence question.",
      payload: {user_message: state.idea, main_claim: body.main_claim},
      outputSchema: "MentorChallengeReport",
    });
    const report = await this.subagentHarness.invoke(packet);
    if (report.status === "completed") {
      const output = report.output as {
        evidence_question?: string;
        impact_level?: string;
      };
      writeDisagreementLog(this.artifactManager, state.run_id, {
        source_run_id: state.run_id,
        topic: "User-agent disagreement",
        user_position: state.idea,
        agent_position: body.main_claim,
        verification_task: String(output.evidence_question ?? ""),
        impact_on_idea_version: (output.impact_level as "Minor" | "Major" | "Fatal") ?? "Minor",
        status: "open",
        evidence_for_user: [],
        evidence_for_agent: [],
        current_resolution: "",
      });
    }
  }

  private async maybeRunCandidateReview(
    state: IdeaPlanState,
    body: ResearchIdeaPlanBody,
  ): Promise<void> {
    const packet = createHandoffPacket({
      threadId: state.thread_id,
      runId: state.run_id,
      role: "candidate_reviewer",
      task: "Review candidate idea and produce five-dimension scores with Advance/Revise/Provisional decision.",
      payload: {main_claim: body.main_claim, mechanism_sketch: body.mechanism_sketch},
      outputSchema: "CandidateIdeaReview",
    });
    this.workspace.add_event(state.run_id, "subagent.handoff", {
      role: packet.role,
      packet_id: packet.packet_id,
    });
    const report = await this.subagentHarness.invoke(packet);
    this.workspace.add_event(state.run_id, "subagent.report", {
      role: report.role,
      status: report.status,
      packet_id: report.packet_id,
    });
    if (report.status === "completed" && report.output.scores) {
      const output = report.output as {
        decision?: string;
        confidence?: string;
        scores?: Record<string, number>;
        why_not_engineering_stitching?: string;
        summary?: string;
      };
      if (output.why_not_engineering_stitching) {
        body.why_not_engineering_stitching = output.why_not_engineering_stitching;
      } else if (!body.why_not_engineering_stitching.trim()) {
        body.why_not_engineering_stitching =
          "CandidateReviewer did not document stitching risks; defaulting to mechanism-level novelty claim.";
      }
      const artifact = this.workspace.latest_plan_artifact_for_thread(state.thread_id);
      if (artifact && output.decision) {
        this.workspace.record_idea_review(
          state.thread_id,
          artifact.artifact_id,
          artifact.source_run_id,
          output.decision,
          String(output.summary ?? "CandidateReviewer agent review"),
          output.scores as import("@academic-agent/schemas").ReviewScores,
          (output.confidence as "high" | "medium" | "low") ?? "medium",
        );
      }
    }
  }

  private raiseIfCancelled(runId: string): void {
    if (this.workspace.get_run(runId).status === "cancelled") {
      throw new RunCancelled("Run cancelled by user");
    }
  }

  private async emitAssistantStream(runId: string, content: string): Promise<void> {
    const chunks = streamChunks(content, 320);
    for (const [index, chunk] of chunks.entries()) {
      this.raiseIfCancelled(runId);
      this.workspace.add_event(runId, "assistant.delta", {
        index,
        delta: chunk,
        source: "final_answer",
      });
      if (chunks.length > 1 && index < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 3));
      }
    }
    this.workspace.add_event(runId, "assistant.completed", {
      chunks: chunks.length,
      length: content.length,
      source: "final_answer",
    });
  }

  private refreshMemoryMap(runId: string): void {
    const memoryMap = this.memoryManager.rebuild_project_memory_map();
    this.workspace.add_event(runId, "memory.map.updated", {
      path: memoryMap.markdown_path,
      metadata_path: memoryMap.metadata_path,
      record_count: memoryMap.record_count,
      thread_count: memoryMap.thread_count,
    });
  }

  private async maybeRefineConversationSummary(
    runId: string,
    summary: ConversationSummary,
    historyContext: HistoryContextPacket,
  ): Promise<ConversationSummary> {
    const extractorProfile = this.config.profile("extractor");
    if (extractorProfile.provider === "openai_compatible" && !extractorProfile.base_url) {
      return summary;
    }
    this.workspace.add_event(runId, "memory.summary.refine_requested", {
      profile: extractorProfile.profile,
      provider: extractorProfile.provider,
      model: extractorProfile.model,
      summary_id: summary.summary_id,
    });
    try {
      const provider = createIdeaDiagnosisProvider(extractorProfile, this.config.env);
      const request = provider.buildAgentRequest(
        [
          {role: "system", content: conversationSummarySystemPrompt()},
          {role: "user", content: conversationSummaryUserPrompt(summary, historyContext)},
        ],
        [],
      );
      const response = await provider.generateAgentResponse(request, []);
      const content = String(response.output.content ?? "").trim();
      const refined = cleanSummaryText(content);
      if (!refined) {
        throw new Error("Extractor returned an empty conversation summary.");
      }
      this.workspace.add_event(runId, "memory.summary.refined", {
        summary_id: summary.summary_id,
        provider: response.provider,
        model: response.model,
        usage: response.usage,
      });
      return {
        ...summary,
        summary_source: "llm",
        provider: response.provider,
        model: response.model,
        summary_text: refined,
        updated_at: utcNow(),
      };
    } catch (error) {
      this.workspace.add_event(runId, "memory.summary.refine_failed", {
        summary_id: summary.summary_id,
        provider: extractorProfile.provider,
        model: extractorProfile.model,
        error: String(error),
      });
      return summary;
    }
  }

  private async maybeGenerateThreadTitle(
    runId: string,
    threadId: string,
    idea: string,
    diagnosis: Diagnosis,
    history: ThreadMessage[],
  ): Promise<string | null> {
    const thread = this.workspace.get_thread(threadId);
    if (thread.name || history.length > 0) {
      return null;
    }
    this.workspace.add_event(runId, "thread.title.requested", {thread_id: threadId});
    let title: string;
    let source: string;
    try {
      title = await this.provider.generateThreadTitle(idea, diagnosis);
      source = "provider";
    } catch {
      title = fallbackTitle(idea);
      source = "fallback";
    }
    if (isPlaceholderTitle(title)) {
      title = fallbackTitle(idea);
      source = `${source}+fallback`;
    }
    title = this.renameThreadUniquely(threadId, title);
    this.workspace.add_event(runId, "thread.title.generated", {
      thread_id: threadId,
      title,
      source,
    });
    return title;
  }

  private renameThreadUniquely(threadId: string, title: string): string {
    const normalized = title.trim() || fallbackTitle(title);
    const candidates = [normalized, ...Array.from({length: 8}, (_, index) => `${normalized} ${index + 2}`)];
    for (const candidate of candidates) {
      try {
        this.workspace.rename_thread(threadId, candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    const fallback = `${normalized} ${threadId.slice(-4)}`;
    this.workspace.rename_thread(threadId, fallback);
    return fallback;
  }

  async runAcMetaReview(
    threadId: string,
    runId: string,
    draft: import("@academic-agent/schemas").ExtendedResearchIdeaPlanDraft,
  ) {
    const convergence = loadConvergenceForThread(this.workspace, threadId);
    const packet = createHandoffPacket({
      threadId,
      runId,
      role: "ac_meta_review",
      task: "Produce AC meta-review with can_freeze decision.",
      payload: {
        main_claim: draft.body.main_claim,
        diagnosis: draft.diagnosis,
        convergence,
      },
      outputSchema: "IdeaMetaReview",
    });
    this.workspace.add_event(runId, "subagent.handoff", {
      role: packet.role,
      packet_id: packet.packet_id,
    });
    const report = await this.subagentHarness.invoke(packet);
    this.workspace.add_event(runId, "subagent.report", {
      role: report.role,
      status: report.status,
      packet_id: report.packet_id,
    });
    if (report.status !== "completed") {
      throw new Error(report.error ?? "AC meta-review failed");
    }
    const output = report.output as Record<string, unknown>;
    const [metaArtifact, meta] = writeIdeaMetaReview(this.artifactManager, runId, {
      source_run_id: runId,
      candidate: String(output.candidate ?? draft.body.main_claim),
      decision: (output.decision as import("@academic-agent/schemas").ReviewDecision) ?? "Revise",
      confidence: (output.confidence as "high" | "medium" | "low") ?? "medium",
      evidence_summary: String(output.evidence_summary ?? draft.diagnosis.gap),
      closest_related_work: String(output.closest_related_work ?? ""),
      main_disagreements: Array.isArray(output.main_disagreements)
        ? output.main_disagreements.map(String)
        : [],
      resolution_of_disagreements: String(output.resolution_of_disagreements ?? ""),
      remaining_risks: Array.isArray(output.remaining_risks)
        ? output.remaining_risks.map(String)
        : [],
      why_not_engineering_stitching: String(
        output.why_not_engineering_stitching ?? draft.body.why_not_engineering_stitching,
      ),
      conditions_for_freeze: Array.isArray(output.conditions_for_freeze)
        ? output.conditions_for_freeze.map(String)
        : [],
      can_freeze: Boolean(output.can_freeze),
    });
    return {artifact: metaArtifact, meta_review: meta};
  }

  async auto_rename_thread(threadId: string): Promise<string> {
    this.workspace.get_thread(threadId);
    const messages = this.workspace
      .list_messages(threadId)
      .filter((message) => message.role === "user" || message.role === "assistant")
      .filter((message) => message.content.trim());
    const latestUser = [...messages].reverse().find((message) => message.role === "user") ?? null;
    const latestAssistant =
      [...messages].reverse().find((message) => message.role === "assistant") ?? null;
    const idea = latestUser?.content ?? "";
    let diagnosis: Diagnosis;
    try {
      diagnosis =
        latestAssistant !== null
          ? diagnosisFromText(latestAssistant.content)
          : {
              problem: idea,
              gap: "",
              candidate_mechanism: "",
              evidence_needed: [],
              main_uncertainty: "",
              clarifying_questions: [],
            };
    } catch {
      diagnosis = {
        problem: idea,
        gap: "",
        candidate_mechanism: "",
        evidence_needed: [],
        main_uncertainty: "",
        clarifying_questions: [],
      };
    }
    let title: string;
    try {
      title = await this.provider.generateThreadTitle(idea, diagnosis);
    } catch {
      title = fallbackTitleFromMessages(messages);
    }
    if (isPlaceholderTitle(title)) {
      title = fallbackTitleFromMessages(messages);
    }
    return this.renameThreadUniquely(threadId, title);
  }
}
