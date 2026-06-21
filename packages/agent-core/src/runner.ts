import {AgentConfig} from "@academic-agent/config";
import {
  ArtifactManager,
  CacheManager,
  ContextBuilder,
  MemoryManager,
  TraceRecorder,
} from "@academic-agent/harness";
import {
  ProviderError,
  createIdeaDiagnosisProvider,
  diagnosisFromText,
  type IdeaDiagnosisProvider,
} from "@academic-agent/providers";
import {createDefaultSearchEngine, getDefaultTools, type ToolRegistry} from "@academic-agent/search";
import {
  SearchResponseSchema,
  type ConversationSummary,
  type CreateIdeaPlanRunResponse,
  type Diagnosis,
  type ModeRun,
  type ProviderRequest,
  type ProviderResponse,
  type ThreadMessage,
  utcNow,
} from "@academic-agent/schemas";
import {ProjectWorkspace} from "@academic-agent/workspace";

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
import {
  assistantSummary,
  extractToolCalls,
  fallbackDiagnosis,
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
  readonly toolRegistry: ToolRegistry;
  readonly maxIterations: number;

  constructor(workspace: ProjectWorkspace) {
    this.workspace = workspace;
    this.memoryManager = new MemoryManager(workspace);
    this.cacheManager = new CacheManager(workspace);
    this.traceRecorder = new TraceRecorder(workspace);
    this.artifactManager = new ArtifactManager(workspace);
    this.config = AgentConfig.load(workspace.projectRoot);
    this.providerProfile = this.config.profile("planner");
    this.provider = createIdeaDiagnosisProvider(this.providerProfile, this.config.env);
    this.toolRegistry = getDefaultTools(createDefaultSearchEngine(this.config.search, this.config.env));
    this.maxIterations = this.providerProfile.max_agent_iterations;
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
    this.addActivity(
      run.run_id,
      "activity.started",
      "planning",
      "我已收到这轮输入，先判断它如何更新当前 Idea Plan。",
    );

    const history = this.workspace
      .list_messages(run.thread_id)
      .filter((message) => message.run_id !== runId);
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
      this.addActivity(
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
    };

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

    this.workspace.add_event(runId, "agent.thinking", {iteration});
    this.addActivity(
      runId,
      iteration === 0 ? "activity.updated" : "activity.updated",
      "planning",
      iteration === 0
        ? "我在整理上下文、近邻文献需求和下一步动作。"
        : "我在结合工具观察结果更新诊断。",
      {iteration},
    );

    const messages = state.messages;
    const tools = this.toolRegistry.getAllDefinitions();
    const providerRequest = this.provider.buildAgentRequest(messages, tools);

    this.workspace.add_event(runId, "provider.requested", {
      provider: providerRequest.provider,
      model: providerRequest.model,
      profile: providerRequest.profile,
      request_id: providerRequest.request_id,
      live: providerRequest.provider !== "mock",
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
      this.addActivity(
        runId,
        "activity.completed",
        "thinking",
        "命中本地 app cache，我复用上一轮相同输入下的模型结果。",
        {provider: providerRequest.provider, model: providerRequest.model},
      );
    } else {
      this.addActivity(
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
      this.addActivity(
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
      this.workspace.add_event(runId, "decision.made", {
        decision: "call_tools",
        tool_names: toolCalls.map((toolCall) => toolCall.name),
      });
      this.addActivity(runId, "activity.updated", "deciding", toolDecisionMessage(toolCalls), {
        tool_names: toolCalls.map((toolCall) => toolCall.name),
      });
    } else {
      this.addActivity(
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

    for (const toolCall of toolCalls) {
      const callId = toolCall.call_id;
      const toolMessage = toolStartMessage(toolCall.name, toolCall.arguments);
      this.addActivity(
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
      this.workspace.add_event(runId, "action.started", {
        tool_name: toolCall.name,
        tool_call_id: callId,
        arguments: toolCall.arguments,
      });

      const result = await this.toolRegistry.execute(toolCall.name, toolCall.arguments);
      const resultText = JSON.stringify(result);
      const resultSummary = toolResultSummary(toolCall.name, result);

      if (toolCall.name === "paper_search") {
        try {
          const searchResponse = SearchResponseSchema.parse(result);
          const [artifact] = this.artifactManager.write_paper_search_evidence(
            runId,
            searchResponse,
          );
          this.workspace.add_event(runId, "paper_search.evidence.created", {
            artifact_id: artifact.artifact_id,
            artifact_type: artifact.artifact_type,
            path: artifact.path,
            metadata_path: artifact.metadata_path,
            query: searchResponse.query,
            result_count: searchResponse.results.length,
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

      const resultError = result.error;
      const resultItems = result.results;
      const hasResults = Array.isArray(resultItems) && resultItems.length > 0;
      const isError = Boolean(resultError) && !hasResults;
      this.workspace.add_event(runId, "observation.summary", {
        tool_name: toolCall.name,
        tool_call_id: callId,
        error: isError,
        partial_error: Boolean(resultError) && hasResults,
        result_length: resultText.length,
        ...resultSummary,
      });
      this.addActivity(
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

    return {...state, messages: newMessages, tool_calls: []};
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
    this.addActivity(
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
    this.addActivity(runId, "activity.started", "answering", "我开始把诊断流式输出给你。");
    this.workspace.add_event(runId, "assistant.reset", {reason: "final_answer"});
    await this.emitAssistantStream(runId, assistantContent);
    this.addActivity(
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
    const [artifact, draft] = this.artifactManager.write_research_idea_draft(
      runId,
      diagnosis,
      context,
      traceRefs,
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
    this.addActivity(
      runId,
      "activity.updated",
      "thinking",
      "planner 已进入流式输出；我会实时展示可见内容，隐藏推理链只保留为内部记录。",
      {provider: providerRequest.provider, model: providerRequest.model},
    );

    let chunks = 0;
    let reasoningChunks = 0;
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
          this.workspace.add_event(runId, "assistant.delta", {
            index: chunks,
            delta,
            source: "provider_stream",
          });
          chunks += 1;
          continue;
        }
        if (chunkType === "reasoning_delta") {
          reasoningChunks += 1;
          continue;
        }
        if (chunkType === "tool_call_delta") {
          this.workspace.add_event(runId, "provider.tool_call.delta", {
            tool_count: (chunk.tool_calls ?? []).length,
            source: "provider_stream",
          });
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
        this.addActivity(
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

    if (chunks > 0) {
      this.workspace.add_event(runId, "assistant.completed", {
        chunks,
        source: "provider_stream",
        reasoning_chunks_hidden: reasoningChunks,
      });
    }
    this.workspace.add_event(runId, "provider.stream.completed", {
      provider: finalResponse.provider,
      model: finalResponse.model,
      response_id: finalResponse.response_id,
      chunks,
      reasoning_chunks_hidden: reasoningChunks,
    });
    return finalResponse;
  }

  private async synthesizeFinalDiagnosis(state: IdeaPlanState, idea: string): Promise<Diagnosis> {
    const runId = state.run_id;
    this.addActivity(
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
      live: request.provider !== "mock",
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
      this.addActivity(
        runId,
        "activity.completed",
        "synthesizing",
        "已根据工具观察结果完成最终诊断收束。",
      );
      return diagnosis;
    } catch (error) {
      this.workspace.add_event(runId, "final_synthesis.failed", {error: String(error)});
      this.addActivity(
        runId,
        "activity.completed",
        "synthesizing",
        "最终诊断收束失败，将使用保底诊断并提示重新运行。",
      );
      return fallbackDiagnosis(idea);
    }
  }

  private raiseIfCancelled(runId: string): void {
    if (this.workspace.get_run(runId).status === "cancelled") {
      throw new RunCancelled("Run cancelled by user");
    }
  }

  private addActivity(
    runId: string,
    eventType: string,
    stage: string,
    message: string,
    payload: Record<string, unknown> = {},
  ): void {
    this.workspace.add_event(runId, eventType, {stage, message, ...payload});
  }

  private async emitAssistantStream(runId: string, content: string): Promise<void> {
    const chunks = streamChunks(content);
    for (const [index, chunk] of chunks.entries()) {
      this.raiseIfCancelled(runId);
      this.workspace.add_event(runId, "assistant.delta", {index, delta: chunk});
      if (chunks.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 3));
      }
    }
    this.workspace.add_event(runId, "assistant.completed", {
      chunks: chunks.length,
      length: content.length,
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
    if (extractorProfile.provider === "mock") {
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
          : fallbackDiagnosis(idea);
    } catch {
      diagnosis = fallbackDiagnosis(idea);
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
