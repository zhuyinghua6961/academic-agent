import {resolve} from "node:path";
import {AgentConfig} from "@academic-agent/config";
import {IdeaPlanRunner, buildContextUsage, buildThreadArtifactContext} from "@academic-agent/agent-core";
import {ArtifactManager, MemoryManager} from "@academic-agent/harness";
import {SetupConflictError, SetupManager} from "@academic-agent/setup";
import type {
  AppCacheClearResponse,
  AppCacheListResponse,
  ArtifactReadResponse,
  ContextUsageResponse,
  ContinueIdeaPlanThreadRequest,
  CreateIdeaPlanRunRequest,
  CurrentIdeaPlanResponse,
  FreezeIdeaPlanResponse,
  ModeRun,
  ProviderProfilesResponse,
  RenameThreadRequest,
  ReviewIdeaPlanRequest,
  ReviewIdeaPlanResponse,
  RunResultResponse,
  SSEEvent,
  SetupApplyRequest,
  SetupApplyResponse,
  SetupStatusResponse,
  SetupVerifyLlmRequest,
  SetupVerifyLlmResponse,
  SetupVerifySearchRequest,
  SetupVerifySearchResponse,
  StartIdeaPlanRunResponse,
  ThreadContextResponse,
  ThreadListResponse,
  ThreadMessagesResponse,
  ProjectStatus,
  WorkflowThread,
} from "@academic-agent/schemas";
import {ProjectWorkspace} from "@academic-agent/workspace";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

export class CoreServiceError extends Error {
  constructor(
    message: string,
    readonly status = 500,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CoreServiceError";
  }
}

export class AcademicAgentCore {
  readonly workspace: ProjectWorkspace;
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly setupManager: SetupManager;

  constructor(projectRoot?: string) {
    const root = projectRoot ?? process.env.ACADEMIC_AGENT_PROJECT_ROOT ?? process.cwd();
    this.workspace = new ProjectWorkspace(resolve(root));
    this.setupManager = new SetupManager(this.workspace.projectRoot);
  }

  private requireConfigured(): void {
    const config = AgentConfig.load(this.workspace.projectRoot);
    if (config.setup_state() !== "configured") {
      throw new CoreServiceError(
        "Complete provider setup before starting a run.",
        409,
        "configuration_required",
      );
    }
  }

  setupStatus(): SetupStatusResponse {
    return this.setupManager.status();
  }

  async verifySetupLlm(request: SetupVerifyLlmRequest): Promise<SetupVerifyLlmResponse> {
    return this.setupManager.verifyLlm(request);
  }

  async verifySetupSearch(request: SetupVerifySearchRequest): Promise<SetupVerifySearchResponse> {
    return this.setupManager.verifySearch(request);
  }

  applySetup(request: SetupApplyRequest): SetupApplyResponse {
    try {
      return this.setupManager.apply(request);
    } catch (error) {
      if (error instanceof SetupConflictError) {
        throw new CoreServiceError(error.message, 409, "setup_conflict");
      }
      throw error;
    }
  }

  initProject(): ProjectStatus {
    return this.workspace.init();
  }

  providerProfiles(): ProviderProfilesResponse {
    const config = AgentConfig.load(this.workspace.projectRoot);
    return {
      profiles: config.statuses(),
      config_sources: config.sources,
    };
  }

  listThreads(limit = 50): ThreadListResponse {
    return {threads: this.workspace.list_thread_sessions(limit)};
  }

  getThread(threadId: string): WorkflowThread {
    try {
      return this.workspace.get_thread(threadId);
    } catch {
      throw new CoreServiceError(`Unknown thread: ${threadId}`, 404);
    }
  }

  findThreadByName(name: string): WorkflowThread {
    try {
      return this.workspace.find_thread_by_name(name);
    } catch {
      throw new CoreServiceError(`Unknown thread name: ${name}`, 404);
    }
  }

  renameThread(threadId: string, payload: RenameThreadRequest): WorkflowThread {
    try {
      return this.workspace.rename_thread(threadId, payload.name);
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists")) {
        throw new CoreServiceError(error.message, 409);
      }
      throw new CoreServiceError(String(error), 404);
    }
  }

  async autoRenameThread(threadId: string): Promise<WorkflowThread> {
    const runner = new IdeaPlanRunner(this.workspace);
    await runner.auto_rename_thread(threadId);
    return this.getThread(threadId);
  }

  readThreadMessages(threadId: string): ThreadMessagesResponse {
    try {
      const thread = this.workspace.get_thread(threadId);
      const messages = this.workspace.list_messages(threadId);
      if (messages.length === 0) {
        throw new CoreServiceError(`Unknown thread: ${threadId}`, 404);
      }
      return {thread, messages};
    } catch (error) {
      if (error instanceof CoreServiceError) throw error;
      throw new CoreServiceError(String(error), 404);
    }
  }

  readThreadPlan(threadId: string): CurrentIdeaPlanResponse {
    const thread = this.getThread(threadId);
    const artifact = this.workspace.latest_plan_artifact_for_thread(threadId);
    if (!artifact) {
      return {
        thread,
        artifact: null,
        draft: null,
        session_status: "needs literature",
      };
    }
    const manager = new ArtifactManager(this.workspace);
    if (artifact.artifact_type === "ResearchIdeaPlan") {
      const [, plan] = manager.read_research_idea_plan(artifact.artifact_id);
      return {
        thread,
        artifact,
        draft: plan,
        session_status: this.workspace.thread_session_status(threadId),
        latest_run_id: artifact.source_run_id,
        latest_status: this.workspace.get_run(artifact.source_run_id).status,
      };
    }
    const [, draft] = manager.read_research_idea_draft(artifact.artifact_id);
    return {
      thread,
      artifact,
      draft,
      session_status: this.workspace.thread_session_status(threadId),
      latest_run_id: artifact.source_run_id,
      latest_status: this.workspace.get_run(artifact.source_run_id).status,
    };
  }

  readThreadArtifact(threadId: string): ArtifactReadResponse {
    this.getThread(threadId);
    const artifact = this.workspace.latest_plan_artifact_for_thread(threadId);
    if (!artifact) {
      throw new CoreServiceError(`No idea plan artifact for thread: ${threadId}`, 404);
    }
    const manager = new ArtifactManager(this.workspace);
    const [metadata, content] = manager.read_artifact_content(artifact.artifact_id);
    return {metadata, content};
  }

  readThreadContext(threadId: string, draft = ""): ThreadContextResponse {
    const thread = this.getThread(threadId);
    const artifactContext = buildThreadArtifactContext(this.workspace, threadId, draft);
    return {
      thread,
      artifact_context: {
        prompt_text: artifactContext.prompt_text,
        source_refs: artifactContext.source_refs,
        estimated_tokens: artifactContext.estimated_tokens,
        token_budget: artifactContext.token_budget,
      },
      content: artifactContext.prompt_text,
    };
  }

  contextUsage(threadId?: string, draft = ""): ContextUsageResponse {
    this.requireConfigured();
    return buildContextUsage(this.workspace, threadId ?? null, draft);
  }

  freezeThreadPlan(threadId: string): FreezeIdeaPlanResponse {
    const thread = this.getThread(threadId);
    const artifact = this.workspace.latest_plan_artifact_for_thread(threadId);
    if (!artifact) {
      throw new CoreServiceError(`No idea plan draft for thread: ${threadId}`, 404);
    }
    const manager = new ArtifactManager(this.workspace);
    if (artifact.artifact_type === "ResearchIdeaPlan") {
      const [, plan] = manager.read_research_idea_plan(artifact.artifact_id);
      return {thread, artifact, plan};
    }
    const [sourceMetadata, draft] = manager.read_research_idea_draft(artifact.artifact_id);
    const [frozenArtifact, plan] = manager.freeze_research_idea_plan(sourceMetadata, draft);
    this.workspace.add_event(draft.source_run_id, "plan.frozen", {
      artifact_id: frozenArtifact.artifact_id,
      source_draft_artifact_id: sourceMetadata.artifact_id,
      thread_id: threadId,
    });
    const memoryMap = new MemoryManager(this.workspace).rebuild_project_memory_map();
    this.workspace.add_event(draft.source_run_id, "memory.map.updated", {
      path: memoryMap.markdown_path,
      metadata_path: memoryMap.metadata_path,
      record_count: memoryMap.record_count,
      thread_count: memoryMap.thread_count,
    });
    return {thread, artifact: frozenArtifact, plan};
  }

  reviewThreadPlan(threadId: string, payload: ReviewIdeaPlanRequest): ReviewIdeaPlanResponse {
    const thread = this.getThread(threadId);
    const artifact = this.workspace.latest_plan_artifact_for_thread(threadId);
    if (!artifact) {
      throw new CoreServiceError(`No idea plan draft for thread: ${threadId}`, 404);
    }
    this.workspace.record_idea_review(
      threadId,
      artifact.artifact_id,
      artifact.source_run_id,
      payload.decision,
      payload.notes ?? null,
    );
    this.workspace.add_event(artifact.source_run_id, "idea.review.recorded", {
      thread_id: threadId,
      artifact_id: artifact.artifact_id,
      decision: payload.decision,
      notes: payload.notes ?? null,
    });
    const memoryMap = new MemoryManager(this.workspace).rebuild_project_memory_map();
    this.workspace.add_event(artifact.source_run_id, "memory.map.updated", {
      path: memoryMap.markdown_path,
      metadata_path: memoryMap.metadata_path,
      record_count: memoryMap.record_count,
      thread_count: memoryMap.thread_count,
    });
    return {
      thread,
      decision: payload.decision,
      session_status: this.workspace.thread_session_status(threadId),
      notes: payload.notes ?? null,
    };
  }

  listCache(): AppCacheListResponse {
    return {records: this.workspace.list_app_cache_records()};
  }

  clearCache(): AppCacheClearResponse {
    return {deleted: this.workspace.clear_app_cache_records()};
  }

  async startIdeaPlanRun(payload: CreateIdeaPlanRunRequest): Promise<StartIdeaPlanRunResponse> {
    this.requireConfigured();
    const runner = new IdeaPlanRunner(this.workspace);
    const run = await runner.create_run(payload.idea, payload.thread_id ?? null);
    void this.executeRunInBackground(run.run_id);
    return {
      run,
      run_url: `/runs/${run.run_id}`,
      events_url: `/runs/${run.run_id}/events`,
    };
  }

  async continueIdeaPlanThread(
    threadId: string,
    payload: ContinueIdeaPlanThreadRequest,
  ): Promise<StartIdeaPlanRunResponse> {
    if (this.workspace.list_messages(threadId).length === 0) {
      throw new CoreServiceError(`Unknown thread: ${threadId}`, 404);
    }
    return this.startIdeaPlanRun({idea: payload.content, thread_id: threadId});
  }

  getRun(runId: string): ModeRun {
    try {
      return this.workspace.get_run(runId);
    } catch {
      throw new CoreServiceError(`Unknown run: ${runId}`, 404);
    }
  }

  cancelRun(runId: string): ModeRun {
    const run = this.getRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return run;
    }
    const cancelled = this.workspace.update_run(runId, "cancelled", undefined, "Run cancelled by user");
    this.workspace.add_event(runId, "run.cancelled", {reason: "Run cancelled by user"});
    return cancelled;
  }

  getRunResult(runId: string): RunResultResponse {
    const run = this.getRun(runId);
    if (run.status !== "completed" || !run.artifact_id) {
      throw new CoreServiceError(`Run ${runId} is not completed`, 409);
    }
    const manager = new ArtifactManager(this.workspace);
    const [artifact, draft] = manager.read_research_idea_draft(run.artifact_id);
    return {
      run,
      artifact,
      draft,
      thread: this.workspace.get_thread(run.thread_id),
      messages: this.workspace.list_messages(run.thread_id),
    };
  }

  listEventsAfter(runId: string, ordinal: number): SSEEvent[] {
    this.getRun(runId);
    return this.workspace.list_events_after(runId, ordinal);
  }

  async *watchRunEvents(
    runId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<SSEEvent, void, void> {
    let lastOrdinal = 0;
    while (!signal?.aborted) {
      const events = this.listEventsAfter(runId, lastOrdinal);
      for (const event of events) {
        lastOrdinal = event.ordinal;
        yield event;
      }
      const run = this.getRun(runId);
      if (TERMINAL_RUN_STATUSES.has(run.status) && events.length === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private executeRunInBackground(runId: string): void {
    const task = (async () => {
      try {
        await new IdeaPlanRunner(this.workspace).execute_run(runId);
      } catch {
        // execute_run records failures; swallow to avoid crashing the CLI process.
      } finally {
        this.tasks.delete(runId);
      }
    })();
    this.tasks.set(runId, task);
  }
}
