import {AcademicAgentCore, CoreServiceError} from "@academic-agent/core-service";
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
  PlanConvergenceStatus,
  ThreadPapersResponse,
  WorkflowThread,
} from "@academic-agent/schemas";

export class ClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ClientError";
  }
}

export function isConfigurationRequired(error: unknown): boolean {
  return error instanceof ClientError && error.code === "configuration_required";
}

export class AcademicAgentClient {
  readonly core: AcademicAgentCore;

  constructor(projectRoot?: string) {
    this.core = new AcademicAgentCore(projectRoot);
  }

  private wrap<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof CoreServiceError) {
        throw new ClientError(error.message, error.status, error.code);
      }
      throw error;
    }
  }

  private async wrapAsync<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof CoreServiceError) {
        throw new ClientError(error.message, error.status, error.code);
      }
      throw error;
    }
  }

  initProject() {
    return this.wrap(() => this.core.initProject());
  }

  setupStatus(): SetupStatusResponse {
    return this.wrap(() => this.core.setupStatus());
  }

  verifySetupLlm(request: SetupVerifyLlmRequest): Promise<SetupVerifyLlmResponse> {
    return this.wrapAsync(() => this.core.verifySetupLlm(request));
  }

  verifySetupSearch(request: SetupVerifySearchRequest): Promise<SetupVerifySearchResponse> {
    return this.wrapAsync(() => this.core.verifySetupSearch(request));
  }

  applySetup(request: SetupApplyRequest): SetupApplyResponse {
    return this.wrap(() => this.core.applySetup(request));
  }

  providerProfiles(): ProviderProfilesResponse {
    return this.wrap(() => this.core.providerProfiles());
  }

  listThreads(limit = 50): ThreadListResponse {
    return this.wrap(() => this.core.listThreads(limit));
  }

  getThread(threadId: string): WorkflowThread {
    return this.wrap(() => this.core.getThread(threadId));
  }

  findThreadByName(name: string): WorkflowThread {
    return this.wrap(() => this.core.findThreadByName(name));
  }

  readThreadMessages(threadId: string): ThreadMessagesResponse {
    return this.wrap(() => this.core.readThreadMessages(threadId));
  }

  readThreadPlan(threadId: string): CurrentIdeaPlanResponse {
    return this.wrap(() => this.core.readThreadPlan(threadId));
  }

  readThreadArtifact(threadId: string): ArtifactReadResponse {
    return this.wrap(() => this.core.readThreadArtifact(threadId));
  }

  readThreadContext(threadId: string, draft = ""): ThreadContextResponse {
    return this.wrap(() => this.core.readThreadContext(threadId, draft));
  }

  contextUsage(threadId?: string, draft = ""): ContextUsageResponse {
    return this.wrap(() => this.core.contextUsage(threadId, draft));
  }

  renameThread(threadId: string, payload: RenameThreadRequest): WorkflowThread {
    return this.wrap(() => this.core.renameThread(threadId, payload));
  }

  async autoRenameThread(threadId: string): Promise<WorkflowThread> {
    return this.wrapAsync(() => this.core.autoRenameThread(threadId));
  }

  freezeThreadPlan(threadId: string): FreezeIdeaPlanResponse {
    return this.wrap(() => this.core.freezeThreadPlan(threadId));
  }

  threadConvergence(threadId: string): PlanConvergenceStatus {
    return this.wrap(() => this.core.threadConvergence(threadId));
  }

  listThreadPapers(threadId: string): ThreadPapersResponse {
    return this.wrap(() => this.core.listThreadPapers(threadId));
  }

  triggerIdeaMetaReview(threadId: string) {
    return this.wrapAsync(() => this.core.triggerIdeaMetaReview(threadId));
  }

  registerThreadPaper(
    threadId: string,
    localPath: string,
    options?: {title?: string; doi?: string; arxiv_id?: string},
  ) {
    return this.wrap(() => this.core.registerThreadPaper(threadId, localPath, options));
  }

  linkThreadPaperEvidence(threadId: string, evidenceId: string, paperId: string) {
    return this.wrap(() => this.core.linkThreadPaperEvidence(threadId, evidenceId, paperId));
  }

  setThreadReadingRequest(
    threadId: string,
    request: {mode: "quick" | "guided" | "exam"; paper_id: string; query?: string},
  ) {
    return this.wrap(() => this.core.setThreadReadingRequest(threadId, request));
  }

  triggerExperimentMetaReview(threadId: string) {
    return this.wrapAsync(() => this.core.triggerExperimentMetaReview(threadId));
  }

  switchThreadToIdeaPlan(threadId: string) {
    return this.wrap(() => this.core.switchThreadToIdeaPlan(threadId));
  }

  listThreadHooks(threadId: string) {
    return this.wrap(() => this.core.listThreadHooks(threadId));
  }

  listThreadDisagreements(threadId: string) {
    return this.wrap(() => this.core.listThreadDisagreements(threadId));
  }

  readThreadBlueprint(threadId: string) {
    return this.wrap(() => this.core.readThreadBlueprint(threadId));
  }

  startExperimentDesignRun(threadId: string, content: string): Promise<StartIdeaPlanRunResponse> {
    return this.wrapAsync(() => this.core.startExperimentDesignRun(threadId, content));
  }

  freezeThreadBlueprint(threadId: string) {
    return this.wrap(() => this.core.freezeThreadBlueprint(threadId));
  }

  reviewThreadBlueprint(threadId: string, decision: string, notes?: string | null) {
    return this.wrap(() => this.core.reviewThreadBlueprint(threadId, decision, notes));
  }

  pauseThread(threadId: string, reason?: string | null): WorkflowThread {
    return this.wrap(() => this.core.pauseThread(threadId, reason));
  }

  reviewThreadPlan(threadId: string, payload: ReviewIdeaPlanRequest): ReviewIdeaPlanResponse {
    return this.wrap(() => this.core.reviewThreadPlanWithSideEffects(threadId, payload));
  }

  listCache(): AppCacheListResponse {
    return this.wrap(() => this.core.listCache());
  }

  clearCache(): AppCacheClearResponse {
    return this.wrap(() => this.core.clearCache());
  }

  startIdeaPlanRun(payload: CreateIdeaPlanRunRequest): Promise<StartIdeaPlanRunResponse> {
    return this.wrapAsync(() => this.core.startIdeaPlanRun(payload));
  }

  continueIdeaPlanThread(
    threadId: string,
    payload: ContinueIdeaPlanThreadRequest,
  ): Promise<StartIdeaPlanRunResponse> {
    return this.wrapAsync(() => this.core.continueIdeaPlanThread(threadId, payload));
  }

  cancelRun(runId: string): ModeRun {
    return this.wrap(() => this.core.cancelRun(runId));
  }

  getRun(runId: string): ModeRun {
    return this.wrap(() => this.core.getRun(runId));
  }

  getRunResult(runId: string): RunResultResponse {
    return this.wrap(() => this.core.getRunResult(runId));
  }

  async watchRunEvents(
    runId: string,
    onEvent: (event: SSEEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    for await (const event of this.core.watchRunEvents(runId, signal)) {
      if (signal?.aborted) {
        return;
      }
      onEvent(event);
    }
  }
}
