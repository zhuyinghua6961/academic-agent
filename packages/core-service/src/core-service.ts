import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {AgentConfig} from "@academic-agent/config";
import {
  ExperimentDesignRunner,
  IdeaPlanRunner,
  buildContextUsage,
  buildThreadArtifactContext,
  loadConvergenceForThread,
} from "@academic-agent/agent-core";
import {
  ArtifactManager,
  MemoryManager,
  defaultPlanBody,
  freezeExtendedResearchIdeaPlan,
  freezeExperimentBlueprint,
  latestBlueprintArtifact,
  linkEvidenceToPaper,
  readExtendedDraft,
  readExtendedPlan,
  readPaperManifest,
  registerLocalPaper,
  writeExperimentMetaReview,
  writeIdeaMetaReview,
} from "@academic-agent/harness";
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
  ThreadPapersResponse,
  PlanConvergenceStatus,
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
import {ExperimentBlueprintDraftSchema} from "@academic-agent/schemas";
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
    const convergence = loadConvergenceForThread(this.workspace, threadId);
    if (!convergence.can_freeze) {
      const gaps = convergence.checks.filter((c) => !c.satisfied).map((c) => c.id).join(", ");
      throw new CoreServiceError(
        `Plan freeze gate failed. Unsatisfied checks: ${gaps}`,
        409,
        "freeze_gate_failed",
      );
    }
    const meta = this.workspace.latest_artifact_by_type(threadId, "IdeaMetaReview");
    if (!meta) {
      throw new CoreServiceError(
        "AC meta-review required before freeze. Run /meta-review first.",
        409,
        "freeze_gate_failed",
      );
    }
    const artifact = this.workspace.latest_plan_artifact_for_thread(threadId);
    if (!artifact) {
      throw new CoreServiceError(`No idea plan draft for thread: ${threadId}`, 404);
    }
    const manager = new ArtifactManager(this.workspace);
    if (artifact.artifact_type === "ResearchIdeaPlan") {
      const [, plan] = readExtendedPlan(manager, artifact.artifact_id);
      return {thread, artifact, plan: plan as unknown as FreezeIdeaPlanResponse["plan"]};
    }
    const [sourceMetadata, draft] = readExtendedDraft(manager, artifact.artifact_id);
    const latestReview = this.workspace.latest_idea_review(threadId);
    let reviewScores: import("@academic-agent/schemas").ReviewScores | null = null;
    if (latestReview?.scores_json) {
      try {
        reviewScores = JSON.parse(String(latestReview.scores_json)) as import("@academic-agent/schemas").ReviewScores;
      } catch {
        reviewScores = null;
      }
    }
    let metaReviewSummary: string | null = null;
    let metaCanFreeze = false;
    const metaArtifact = this.workspace.latest_artifact_by_type(threadId, "IdeaMetaReview");
    if (metaArtifact) {
      try {
        const payload: unknown = JSON.parse(readFileSync(metaArtifact.metadata_path, "utf8"));
        const record = payload as {meta_review?: {evidence_summary?: string; can_freeze?: boolean}};
        metaReviewSummary = record.meta_review?.evidence_summary ?? null;
        metaCanFreeze = record.meta_review?.can_freeze === true;
      } catch {
        metaReviewSummary = null;
      }
    }
    const [frozenArtifact, plan] = freezeExtendedResearchIdeaPlan(manager, sourceMetadata, draft, {
      reviewDecision: latestReview ? String(latestReview.decision) : null,
      reviewScores,
      reviewConfidence: latestReview?.confidence ? String(latestReview.confidence) : null,
      reviewNotes: latestReview?.notes ? String(latestReview.notes) : null,
      metaReviewSummary,
      metaCanFreeze,
    });
    this.workspace.update_thread_workflow(threadId, {
      current_mode: "experiment_design",
      lifecycle_state: "research_idea_plan_freeze",
    });
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
    return {thread: this.getThread(threadId), artifact: frozenArtifact, plan: plan as unknown as FreezeIdeaPlanResponse["plan"]};
  }

  threadConvergence(threadId: string): PlanConvergenceStatus {
    this.getThread(threadId);
    return loadConvergenceForThread(this.workspace, threadId);
  }

  listThreadPapers(threadId: string): ThreadPapersResponse {
    this.getThread(threadId);
    const manager = new ArtifactManager(this.workspace);
    const evidenceArtifacts = this.workspace.latest_artifacts_for_thread(
      threadId,
      "PaperSearchEvidence",
      20,
    );
    const evidence = evidenceArtifacts.map((meta) => {
      const [, record] = manager.read_paper_search_evidence(meta.artifact_id);
      return {
        artifact_id: meta.artifact_id,
        query: record.query,
        result_count: record.search_response.results.length,
        created_at: meta.created_at,
      };
    });
    const miniReviews = this.workspace
      .latest_artifacts_for_thread(threadId, "PaperMiniReview", 20)
      .map((meta) => ({
        artifact_id: meta.artifact_id,
        title: meta.title.replace(/^PaperMiniReview:\s*/, ""),
        status: "unknown" as const,
        created_at: meta.created_at,
      }));
    return {
      thread_id: threadId,
      evidence,
      manifest_entries: readPaperManifest(this.workspace),
      mini_reviews: miniReviews,
    };
  }

  listThreadHooks(threadId: string) {
    this.getThread(threadId);
    return this.workspace
      .latest_artifacts_for_thread(threadId, "InnovationHook", 20)
      .map((meta) => ({
        artifact_id: meta.artifact_id,
        title: meta.title,
        created_at: meta.created_at,
      }));
  }

  listThreadDisagreements(threadId: string) {
    this.getThread(threadId);
    return this.workspace
      .latest_artifacts_for_thread(threadId, "DisagreementLog", 20)
      .map((meta) => ({
        artifact_id: meta.artifact_id,
        title: meta.title,
        created_at: meta.created_at,
      }));
  }

  readThreadBlueprint(threadId: string): ArtifactReadResponse {
    this.getThread(threadId);
    const artifact = latestBlueprintArtifact(this.workspace, threadId);
    if (!artifact) {
      throw new CoreServiceError("No blueprint artifact for thread", 404);
    }
    const manager = new ArtifactManager(this.workspace);
    const [metadata, content] = manager.read_artifact_content(artifact.artifact_id);
    return {metadata, content};
  }

  setThreadReadingRequest(
    threadId: string,
    request: {mode: "quick" | "guided" | "exam"; paper_id: string; query?: string},
  ): WorkflowThread {
    this.getThread(threadId);
    this.workspace.set_reading_request(threadId, request);
    return this.getThread(threadId);
  }

  async triggerExperimentMetaReview(threadId: string) {
    const blueprint = latestBlueprintArtifact(this.workspace, threadId);
    if (!blueprint) {
      throw new CoreServiceError("No blueprint artifact", 404);
    }
    const manager = new ArtifactManager(this.workspace);
    const runner = new ExperimentDesignRunner(this.workspace);
    const report = await runner.runAcMetaReview(
      threadId,
      blueprint.source_run_id,
      blueprint.artifact_id,
    );
    if (report.status !== "completed") {
      throw new CoreServiceError(report.error ?? "Experiment AC meta-review failed", 500);
    }
    const output = report.output as Record<string, unknown>;
    const [artifact, meta] = writeExperimentMetaReview(manager, blueprint.source_run_id, {
      source_run_id: blueprint.source_run_id,
      can_move_to_execution: Boolean(output.can_move_to_execution),
      baseline_risks: Array.isArray(output.baseline_risks) ? output.baseline_risks.map(String) : [],
      metric_risks: Array.isArray(output.metric_risks) ? output.metric_risks.map(String) : [],
      remaining_risks: Array.isArray(output.remaining_risks) ? output.remaining_risks.map(String) : [],
      conditions_for_freeze: Array.isArray(output.conditions_for_freeze)
        ? output.conditions_for_freeze.map(String)
        : [],
    });
    return {artifact, meta_review: meta};
  }

  registerThreadPaper(
    threadId: string,
    localPath: string,
    options: {title?: string; doi?: string; arxiv_id?: string} = {},
  ) {
    this.getThread(threadId);
    return registerLocalPaper(this.workspace, localPath, options);
  }

  linkThreadPaperEvidence(threadId: string, evidenceId: string, paperId: string) {
    this.getThread(threadId);
    return linkEvidenceToPaper(this.workspace, paperId, evidenceId);
  }

  async triggerIdeaMetaReview(threadId: string) {
    const artifact = this.workspace.latest_plan_artifact_for_thread(threadId);
    if (!artifact) {
      throw new CoreServiceError(`No plan artifact for thread: ${threadId}`, 404);
    }
    const manager = new ArtifactManager(this.workspace);
    const [, draft] = readExtendedDraft(manager, artifact.artifact_id);
    const runner = new IdeaPlanRunner(this.workspace);
    return runner.runAcMetaReview(threadId, artifact.source_run_id, draft);
  }

  async startExperimentDesignRun(threadId: string, content: string): Promise<StartIdeaPlanRunResponse> {
    this.requireConfigured();
    const runner = new ExperimentDesignRunner(this.workspace);
    const run = await runner.create_run(content, threadId);
    void this.executeExperimentRunInBackground(run.run_id);
    return {
      run,
      run_url: `/runs/${run.run_id}`,
      events_url: `/runs/${run.run_id}/events`,
    };
  }

  freezeThreadBlueprint(threadId: string) {
    const blueprintArtifact = latestBlueprintArtifact(this.workspace, threadId);
    if (!blueprintArtifact || blueprintArtifact.artifact_type !== "ExperimentBlueprintDraft") {
      throw new CoreServiceError("No experiment blueprint draft to freeze", 404);
    }
    const latestReview = this.workspace.latest_blueprint_review(threadId);
    if (!latestReview || String(latestReview.decision) !== "Freeze") {
      throw new CoreServiceError("Blueprint review must be Freeze before freezing", 409, "freeze_gate_failed");
    }
    const manager = new ArtifactManager(this.workspace);
    const payload: unknown = JSON.parse(readFileSync(blueprintArtifact.metadata_path, "utf8"));
    const parsedDraft = ExperimentBlueprintDraftSchema.parse((payload as {draft?: unknown}).draft);
    const [frozenArtifact, blueprint] = freezeExperimentBlueprint(
      manager,
      blueprintArtifact,
      parsedDraft,
    );
    return {artifact: frozenArtifact, blueprint};
  }

  reviewThreadBlueprint(threadId: string, decision: string, notes?: string | null) {
    const blueprint = latestBlueprintArtifact(this.workspace, threadId);
    if (!blueprint) {
      throw new CoreServiceError("No blueprint artifact", 404);
    }
    return this.workspace.record_blueprint_review(
      threadId,
      blueprint.artifact_id,
      blueprint.source_run_id,
      decision,
      notes ?? null,
    );
  }

  pauseThread(threadId: string, reason?: string | null): WorkflowThread {
    return this.workspace.update_thread_workflow(threadId, {
      lifecycle_state: "paused",
    });
  }

  switchThreadToIdeaPlan(threadId: string): WorkflowThread {
    this.getThread(threadId);
    return this.workspace.update_thread_workflow(threadId, {
      current_mode: "idea_plan",
    });
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
      payload.scores ?? null,
      payload.confidence ?? null,
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

  private async handleRejectReview(threadId: string, artifact: {artifact_id: string; source_run_id: string}, notes: string | null) {
    const manager = new ArtifactManager(this.workspace);
    const [, draft] = readExtendedDraft(manager, artifact.artifact_id);
    const runner = new IdeaPlanRunner(this.workspace);
    await runner.runResearchMentorForThread(
      threadId,
      artifact.source_run_id,
      notes ?? "Reject review",
      draft.body.main_claim,
    );
  }

  reviewThreadPlanWithSideEffects(threadId: string, payload: ReviewIdeaPlanRequest): ReviewIdeaPlanResponse {
    const response = this.reviewThreadPlan(threadId, payload);
    if (payload.decision === "Reject") {
      const artifact = this.workspace.latest_plan_artifact_for_thread(threadId);
      if (artifact) {
        void this.handleRejectReview(threadId, artifact, payload.notes ?? null);
      }
    }
    return response;
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
        const run = this.workspace.get_run(runId);
        if (run.mode === "experiment_design") {
          await new ExperimentDesignRunner(this.workspace).execute_run(runId);
        } else {
          await new IdeaPlanRunner(this.workspace).execute_run(runId);
        }
      } catch {
        // execute_run records failures; swallow to avoid crashing the CLI process.
      } finally {
        this.tasks.delete(runId);
      }
    })();
    this.tasks.set(runId, task);
  }

  private executeExperimentRunInBackground(runId: string): void {
    this.executeRunInBackground(runId);
  }
}
