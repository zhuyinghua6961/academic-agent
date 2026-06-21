import type {
  AppCacheRecord,
  AppCacheSummaryRecord,
  ArtifactMetadata,
  ConflictRecord,
  MemoryRecord,
  ModeRun,
  ProjectStatus,
  SSEEvent,
  ThreadMessage,
  ThreadSessionSummary,
  TraceRecord,
  WorkflowThread,
} from "@academic-agent/schemas";

export type {
  AppCacheRecord,
  AppCacheSummaryRecord,
  ArtifactMetadata,
  ConflictRecord,
  MemoryRecord,
  ModeRun,
  ProjectStatus,
  SSEEvent,
  ThreadMessage,
  ThreadSessionSummary,
  TraceRecord,
  WorkflowThread,
} from "@academic-agent/schemas";

export interface WorkspacePort {
  readonly projectRoot: string;
  readonly workspaceDir: string;
  readonly dbPath: string;
  readonly projectId: string;
  readonly directories: string[];

  init(): ProjectStatus;
  status(): ProjectStatus;
  ensure_initialized(): void;

  get_thread(threadId: string): WorkflowThread;
  list_threads(limit?: number, includeEmpty?: boolean): WorkflowThread[];
  list_thread_sessions(limit?: number): ThreadSessionSummary[];
  find_thread_by_name(name: string): WorkflowThread;
  rename_thread(threadId: string, name: string): WorkflowThread;
  create_thread(threadId?: string | null, name?: string | null): WorkflowThread;
  update_thread_workflow(
    threadId: string,
    patch: Partial<
      Pick<WorkflowThread, "current_mode" | "lifecycle_state" | "idea_version" | "impact_level">
    >,
  ): WorkflowThread;

  add_message(
    threadId: string,
    role: string,
    content: string,
    runId?: string | null,
    toolCallId?: string | null,
    toolName?: string | null,
    toolArgs?: Record<string, unknown> | null,
    parentMessageId?: string | null,
  ): ThreadMessage;
  list_messages(threadId: string): ThreadMessage[];

  create_run(threadId: string, idea: string, mode?: ModeRun["mode"]): ModeRun;
  import_run(
    runId: string,
    threadId: string,
    idea: string,
    mode?: ModeRun["mode"],
  ): ModeRun;
  update_run(
    runId: string,
    status: ModeRun["status"],
    artifactId?: string | null,
    error?: string | null,
  ): ModeRun;
  get_run(runId: string): ModeRun;
  list_runs(limit?: number): ModeRun[];

  add_event(
    runId: string,
    eventType: string,
    payload?: Record<string, unknown> | null,
  ): SSEEvent;
  list_events(runId: string): SSEEvent[];
  list_events_after(runId: string, ordinal: number): SSEEvent[];

  insert_artifact(metadata: ArtifactMetadata): void;
  latest_artifact_by_type(threadId: string, artifactType: string): ArtifactMetadata | null;
  count_thread_artifacts(threadId: string, artifactType: string): number;
  count_open_disagreements(threadId: string, impactLevel: string): number;
  latest_artifact_for_thread(
    threadId: string,
    artifactType?: string,
  ): ArtifactMetadata | null;
  latest_artifacts_for_thread(
    threadId: string,
    artifactType: string,
    limit?: number,
  ): ArtifactMetadata[];
  latest_plan_artifact_for_thread(threadId: string): ArtifactMetadata | null;
  thread_session_status(threadId: string): string;
  get_artifact_metadata(artifactId: string): ArtifactMetadata;

  record_idea_review(
    threadId: string,
    artifactId: string,
    runId: string,
    decision: string,
    notes?: string | null,
    scores?: Record<string, number> | null,
    confidence?: string | null,
  ): Record<string, unknown>;
  record_blueprint_review(
    threadId: string,
    artifactId: string,
    runId: string,
    decision: string,
    notes?: string | null,
  ): Record<string, unknown>;
  latest_blueprint_review(threadId: string): Record<string, unknown> | null;
  latest_idea_review(threadId: string): Record<string, unknown> | null;
  list_idea_reviews(threadId: string): Record<string, unknown>[];

  upsert_memory_record(record: MemoryRecord): void;
  update_memory_record_status(recordId: string, status: string, updatedAt?: string | null): void;
  list_memory_records(
    threadId?: string | null,
    recordType?: string | null,
    limit?: number,
  ): MemoryRecord[];
  upsert_memory_index(
    recordId: string,
    searchText: string,
    embedding: Record<string, number>,
    sourceHash: string,
    updatedAt?: string | null,
  ): void;
  list_memory_index(): Record<string, Record<string, unknown>>;

  upsert_conflict_record(conflict: ConflictRecord): void;
  list_conflict_records(
    threadId?: string | null,
    status?: string | null,
    limit?: number,
  ): ConflictRecord[];

  insert_trace(trace: TraceRecord): void;
  get_trace(traceId: string): TraceRecord;

  get_app_cache_record(cacheKey: string): AppCacheRecord | null;
  list_app_cache_records(limit?: number): AppCacheSummaryRecord[];
  clear_app_cache_records(): number;
  upsert_app_cache_record(record: AppCacheRecord): void;

  set_reading_request(
    threadId: string,
    request: {mode: "quick" | "guided" | "exam"; paper_id: string; query?: string},
  ): void;
  get_reading_request(
    threadId: string,
  ): {mode: "quick" | "guided" | "exam"; paper_id: string; query?: string} | null;
  clear_reading_request(threadId: string): void;
}
