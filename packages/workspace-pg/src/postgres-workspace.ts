import fs from "node:fs";
import path from "node:path";

import {renderDefaultProjectConfig} from "@academic-agent/config";
import {
  utcNow,
  newId,
  type AppCacheRecord,
  type AppCacheSummaryRecord,
  type ArtifactMetadata,
  type ConflictRecord,
  type MemoryRecord,
  type ModeRun,
  type ProjectStatus,
  type SSEEvent,
  type ThreadMessage,
  type ThreadSessionSummary,
  type TraceRecord,
  type WorkflowThread,
} from "@academic-agent/schemas";
import type {WorkspacePort} from "@academic-agent/workspace-port";
import {Pool} from "pg";

import {
  KeyError,
  bool,
  defaultThreadTitle,
  int,
  jsonDump,
  jsonLoad,
  sessionStatusFromArtifact,
  str,
  strOrNull,
} from "./helpers.js";
import {INIT_SCHEMA_SQL} from "./schema.js";
import {queryOne, queryRows, querySync} from "./sync-query.js";

const REQUIRED_DIRS = ["artifacts", "traces", "memory", "cache"] as const;
type SqlRow = Record<string, unknown>;
type MessageRole = ThreadMessage["role"];

export type PostgresWorkspaceOptions = {
  databaseUrl: string;
  projectId: string;
  projectRoot: string;
  workspaceDir?: string;
};

export class PostgresWorkspace implements WorkspacePort {
  readonly projectRoot: string;
  readonly workspaceDir: string;
  readonly dbPath: string;
  readonly projectId: string;
  private readonly pool: Pool;
  private initialized = false;

  constructor(options: PostgresWorkspaceOptions) {
    this.projectId = options.projectId;
    this.projectRoot = path.resolve(options.projectRoot);
    this.workspaceDir = path.resolve(options.workspaceDir ?? path.join(this.projectRoot, ".academic-agent"));
    this.dbPath = options.databaseUrl;
    this.pool = new Pool({connectionString: options.databaseUrl});
  }

  get directories(): string[] {
    return REQUIRED_DIRS.map((name) => path.join(this.workspaceDir, name));
  }

  private initDb(): void {
    querySync(this.pool, INIT_SCHEMA_SQL);
  }

  init(): ProjectStatus {
    fs.mkdirSync(this.workspaceDir, {recursive: true});
    for (const directory of this.directories) {
      fs.mkdirSync(directory, {recursive: true});
    }

    const memoryMap = path.join(this.workspaceDir, "memory", "project-memory-map.md");
    if (!fs.existsSync(memoryMap)) {
      fs.writeFileSync(
        memoryMap,
        "# Project Memory Map\n\n" +
          "v0 scaffold: memory retrieval is not implemented yet. " +
          "This file is the future navigation entry point for project memory.\n",
        "utf8",
      );
    }

    const configPath = path.join(this.workspaceDir, "config.toml");
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, renderDefaultProjectConfig(), "utf8");
    }

    this.initDb();
    querySync(
      this.pool,
      `
      insert into projects(project_id, project_root, workspace_dir, created_at)
      values ($1, $2, $3, $4)
      on conflict(project_id) do nothing
      `,
      [this.projectId, this.projectRoot, this.workspaceDir, utcNow()],
    );
    this.initialized = true;
    return this.status();
  }

  status(): ProjectStatus {
    const initialized =
      this.initialized &&
      this.directories.every((dirPath) => fs.existsSync(dirPath));
    return {
      project_id: this.projectId,
      project_root: this.projectRoot,
      workspace_dir: this.workspaceDir,
      db_path: this.dbPath,
      initialized,
      directories: this.directories,
    };
  }

  ensure_initialized(): void {
    if (!this.status().initialized) {
      this.init();
    }
  }

  private threadFromRow(row: SqlRow): WorkflowThread {
    return {
      thread_id: str(row, "thread_id"),
      project_id: str(row, "project_id"),
      name: strOrNull(row, "name"),
      created_at: str(row, "created_at"),
      current_mode: (strOrNull(row, "current_mode") ?? "idea_plan") as WorkflowThread["current_mode"],
      lifecycle_state: (strOrNull(row, "lifecycle_state") ??
        "lightweight_diagnosis") as WorkflowThread["lifecycle_state"],
      idea_version: row.idea_version != null ? int(row, "idea_version") : 1,
      impact_level: (strOrNull(row, "impact_level") ?? "None") as WorkflowThread["impact_level"],
    };
  }

  private static readonly THREAD_SELECT =
    "select thread_id, project_id, name, created_at, current_mode, lifecycle_state, idea_version, impact_level from threads";

  get_thread(threadId: string): WorkflowThread {
    this.ensure_initialized();
    const row = queryOne(this.pool, `${PostgresWorkspace.THREAD_SELECT} where thread_id = $1`, [
      threadId,
    ]);
    if (row === undefined) {
      throw new KeyError(`Unknown thread: ${threadId}`);
    }
    return this.threadFromRow(row);
  }

  list_threads(limit = 50, includeEmpty = true): WorkflowThread[] {
    this.ensure_initialized();
    const messageFilter = includeEmpty
      ? ""
      : "where exists (select 1 from messages where messages.thread_id = threads.thread_id)";
    const rows = queryRows(
      this.pool,
      `
      select thread_id, project_id, name, created_at, current_mode, lifecycle_state, idea_version, impact_level
      from threads
      ${messageFilter}
      order by created_at desc
      limit $1
      `,
      [limit],
    );
    return rows.map((row) => this.threadFromRow(row));
  }

  list_thread_sessions(limit = 50): ThreadSessionSummary[] {
    this.ensure_initialized();
    const rows = queryRows(
      this.pool,
      `
      select
          threads.thread_id,
          threads.project_id,
          threads.name,
          threads.created_at,
          count(messages.message_id) as message_count,
          max(messages.created_at) as last_message_at,
          (
              select runs.run_id
              from runs
              where runs.thread_id = threads.thread_id
              order by runs.updated_at desc
              limit 1
          ) as latest_run_id,
          (
              select runs.status
              from runs
              where runs.thread_id = threads.thread_id
              order by runs.updated_at desc
              limit 1
          ) as latest_status,
          (
              select runs.updated_at
              from runs
              where runs.thread_id = threads.thread_id
              order by runs.updated_at desc
              limit 1
          ) as last_run_at,
          (
              select artifacts.artifact_type
              from artifacts
              join runs as artifact_runs on artifact_runs.run_id = artifacts.run_id
              where artifact_runs.thread_id = threads.thread_id
                and artifacts.artifact_type in ('ResearchIdeaPlanDraft', 'ResearchIdeaPlan')
              order by artifacts.created_at desc
              limit 1
          ) as latest_artifact_type,
          (
              select artifacts.status
              from artifacts
              join runs as artifact_runs on artifact_runs.run_id = artifacts.run_id
              where artifact_runs.thread_id = threads.thread_id
                and artifacts.artifact_type in ('ResearchIdeaPlanDraft', 'ResearchIdeaPlan')
              order by artifacts.created_at desc
              limit 1
          ) as latest_artifact_status,
          exists (
              select 1
              from idea_reviews
              where idea_reviews.thread_id = threads.thread_id
          ) as has_review
      from threads
      join messages on messages.thread_id = threads.thread_id and messages.role != 'tool'
      group by threads.thread_id, threads.project_id, threads.name, threads.created_at
      order by coalesce(max(messages.created_at), (
          select runs.updated_at from runs where runs.thread_id = threads.thread_id order by runs.updated_at desc limit 1
      ), threads.created_at) desc
      limit $1
      `,
      [limit],
    );
    return rows.map((row) => ({
      thread_id: str(row, "thread_id"),
      project_id: str(row, "project_id"),
      name: strOrNull(row, "name"),
      title: strOrNull(row, "name") ?? defaultThreadTitle(str(row, "thread_id")),
      created_at: str(row, "created_at"),
      updated_at:
        strOrNull(row, "last_message_at") ??
        strOrNull(row, "last_run_at") ??
        str(row, "created_at"),
      message_count: int(row, "message_count"),
      latest_run_id: strOrNull(row, "latest_run_id"),
      latest_status: strOrNull(row, "latest_status"),
      session_status: sessionStatusFromArtifact(
        strOrNull(row, "latest_artifact_type"),
        strOrNull(row, "latest_artifact_status"),
        bool(row, "has_review"),
      ),
      latest_artifact_type: strOrNull(row, "latest_artifact_type"),
      latest_artifact_status: strOrNull(row, "latest_artifact_status"),
    }));
  }

  find_thread_by_name(name: string): WorkflowThread {
    this.ensure_initialized();
    const normalized = name.trim();
    if (!normalized) {
      throw new Error("Thread name cannot be empty");
    }
    const row = queryOne(
      this.pool,
      `
      select thread_id, project_id, name, created_at, current_mode, lifecycle_state, idea_version, impact_level
      from threads
      where project_id = $1 and name = $2
      `,
      [this.projectId, normalized],
    );
    if (row === undefined) {
      throw new KeyError(`Unknown thread name: ${normalized}`);
    }
    return this.threadFromRow(row);
  }

  rename_thread(threadId: string, name: string): WorkflowThread {
    this.ensure_initialized();
    const normalized = name.trim();
    if (!normalized) {
      throw new Error("Thread name cannot be empty");
    }
    const current = queryOne(this.pool, "select thread_id from threads where thread_id = $1", [
      threadId,
    ]);
    if (current === undefined) {
      throw new KeyError(`Unknown thread: ${threadId}`);
    }
    const conflict = queryOne(
      this.pool,
      `
      select thread_id
      from threads
      where project_id = $1 and name = $2 and thread_id != $3
      `,
      [this.projectId, normalized, threadId],
    );
    if (conflict !== undefined) {
      throw new Error(`Thread name already exists: ${normalized}`);
    }
    querySync(this.pool, "update threads set name = $1 where thread_id = $2", [
      normalized,
      threadId,
    ]);
    return this.get_thread(threadId);
  }

  create_thread(threadId?: string | null, name?: string | null): WorkflowThread {
    this.ensure_initialized();
    const now = utcNow();
    const nextThreadId = threadId ?? newId("thread");
    if (threadId !== undefined && threadId !== null) {
      const existing = queryOne(
        this.pool,
        `${PostgresWorkspace.THREAD_SELECT} where thread_id = $1`,
        [threadId],
      );
      if (existing !== undefined) {
        return this.threadFromRow(existing);
      }
    }
    const thread: WorkflowThread = {
      thread_id: nextThreadId,
      project_id: this.projectId,
      name: name?.trim() ? name.trim() : null,
      created_at: now,
      current_mode: "idea_plan",
      lifecycle_state: "lightweight_diagnosis",
      idea_version: 1,
      impact_level: "None",
    };
    querySync(
      this.pool,
      `
      insert into threads(
        thread_id, project_id, name, created_at,
        current_mode, lifecycle_state, idea_version, impact_level
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict(thread_id) do nothing
      `,
      [
        thread.thread_id,
        thread.project_id,
        thread.name,
        thread.created_at,
        thread.current_mode,
        thread.lifecycle_state,
        thread.idea_version,
        thread.impact_level,
      ],
    );
    return thread;
  }

  add_message(
    threadId: string,
    role: string,
    content: string,
    runId?: string | null,
    toolCallId?: string | null,
    toolName?: string | null,
    toolArgs?: Record<string, unknown> | null,
    parentMessageId?: string | null,
  ): ThreadMessage {
    this.ensure_initialized();
    if (!["user", "assistant", "tool"].includes(role)) {
      throw new Error(`Unsupported message role: ${role}`);
    }
    const messageRole = role as MessageRole;
    const toolArgsJson = toolArgs ? jsonDump(toolArgs) : null;
    const ordinalRow = queryOne(
      this.pool,
      "select coalesce(max(ordinal), 0) + 1 as next_ordinal from messages where thread_id = $1",
      [threadId],
    );
    const message: ThreadMessage = {
      message_id: newId("msg"),
      thread_id: threadId,
      role: messageRole,
      content,
      run_id: runId ?? null,
      created_at: utcNow(),
      ordinal: int(ordinalRow ?? {next_ordinal: 1}, "next_ordinal"),
      tool_call_id: toolCallId ?? null,
      tool_name: toolName ?? null,
      tool_args: toolArgs ?? null,
      parent_message_id: parentMessageId ?? null,
    };
    querySync(
      this.pool,
      `
      insert into messages(message_id, thread_id, role, content, run_id,
                           created_at, ordinal, tool_call_id, tool_name,
                           tool_args_json, parent_message_id)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        message.message_id,
        message.thread_id,
        message.role,
        message.content,
        message.run_id,
        message.created_at,
        message.ordinal,
        message.tool_call_id,
        message.tool_name,
        toolArgsJson,
        message.parent_message_id,
      ],
    );
    return message;
  }

  list_messages(threadId: string): ThreadMessage[] {
    this.ensure_initialized();
    const rows = queryRows(
      this.pool,
      "select * from messages where thread_id = $1 order by ordinal asc",
      [threadId],
    );
    return rows.map((row) => this.messageFromRow(row));
  }

  private messageFromRow(row: SqlRow): ThreadMessage {
    return {
      message_id: str(row, "message_id"),
      thread_id: str(row, "thread_id"),
      role: str(row, "role") as MessageRole,
      content: str(row, "content"),
      run_id: strOrNull(row, "run_id"),
      created_at: str(row, "created_at"),
      ordinal: int(row, "ordinal"),
      tool_call_id: strOrNull(row, "tool_call_id"),
      tool_name: strOrNull(row, "tool_name"),
      tool_args: (() => {
        const loaded = jsonLoad(strOrNull(row, "tool_args_json"));
        return Object.keys(loaded).length > 0 ? loaded : null;
      })(),
      parent_message_id: strOrNull(row, "parent_message_id"),
    };
  }

  create_run(threadId: string, idea: string, mode: ModeRun["mode"] = "idea_plan"): ModeRun {
    this.ensure_initialized();
    const now = utcNow();
    const run: ModeRun = {
      run_id: newId("run"),
      thread_id: threadId,
      mode,
      status: "created",
      input_idea: idea,
      artifact_id: null,
      error: null,
      created_at: now,
      updated_at: now,
    };
    querySync(
      this.pool,
      `
      insert into runs(run_id, thread_id, mode, status, input_idea, artifact_id, error,
                       created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        run.run_id,
        run.thread_id,
        run.mode,
        run.status,
        run.input_idea,
        run.artifact_id,
        run.error,
        run.created_at,
        run.updated_at,
      ],
    );
    return run;
  }

  import_run(
    runId: string,
    threadId: string,
    idea: string,
    mode: ModeRun["mode"] = "idea_plan",
  ): ModeRun {
    this.ensure_initialized();
    const existing = queryOne(this.pool, "select run_id from runs where run_id = $1", [runId]);
    if (existing !== undefined) {
      const run = this.get_run(runId);
      if (run.status === "created") {
        return run;
      }
      throw new Error(`Run ${runId} already exists with status ${run.status}`);
    }
    const now = utcNow();
    const run: ModeRun = {
      run_id: runId,
      thread_id: threadId,
      mode,
      status: "created",
      input_idea: idea,
      artifact_id: null,
      error: null,
      created_at: now,
      updated_at: now,
    };
    querySync(
      this.pool,
      `
      insert into runs(run_id, thread_id, mode, status, input_idea, artifact_id, error,
                       created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        run.run_id,
        run.thread_id,
        run.mode,
        run.status,
        run.input_idea,
        run.artifact_id,
        run.error,
        run.created_at,
        run.updated_at,
      ],
    );
    return run;
  }

  update_run(
    runId: string,
    status: ModeRun["status"],
    artifactId?: string | null,
    error?: string | null,
  ): ModeRun {
    const now = utcNow();
    const existing = queryOne(this.pool, "select artifact_id from runs where run_id = $1", [
      runId,
    ]);
    if (existing === undefined) {
      throw new KeyError(`Unknown run: ${runId}`);
    }
    const nextArtifactId =
      artifactId !== undefined && artifactId !== null
        ? artifactId
        : strOrNull(existing, "artifact_id");
    querySync(
      this.pool,
      `
      update runs
      set status = $1, artifact_id = $2, error = $3, updated_at = $4
      where run_id = $5
      `,
      [status, nextArtifactId, error ?? null, now, runId],
    );
    return this.get_run(runId);
  }

  get_run(runId: string): ModeRun {
    const row = queryOne(this.pool, "select * from runs where run_id = $1", [runId]);
    if (row === undefined) {
      throw new KeyError(`Unknown run: ${runId}`);
    }
    return this.runFromRow(row);
  }

  private runFromRow(row: SqlRow): ModeRun {
    return {
      run_id: str(row, "run_id"),
      thread_id: str(row, "thread_id"),
      mode: str(row, "mode") as ModeRun["mode"],
      status: str(row, "status") as ModeRun["status"],
      input_idea: str(row, "input_idea"),
      artifact_id: strOrNull(row, "artifact_id"),
      error: strOrNull(row, "error"),
      created_at: str(row, "created_at"),
      updated_at: str(row, "updated_at"),
    };
  }

  list_runs(limit = 50): ModeRun[] {
    this.ensure_initialized();
    const rows = queryRows(
      this.pool,
      `
      select * from runs
      order by created_at desc
      limit $1
      `,
      [limit],
    );
    return rows.map((row) => this.runFromRow(row));
  }

  add_event(
    runId: string,
    eventType: string,
    payload?: Record<string, unknown> | null,
  ): SSEEvent {
    this.ensure_initialized();
    const ordinalRow = queryOne(
      this.pool,
      "select coalesce(max(ordinal), 0) + 1 as next_ordinal from events where run_id = $1",
      [runId],
    );
    const event: SSEEvent = {
      event_id: newId("evt"),
      run_id: runId,
      event_type: eventType,
      payload: payload ?? {},
      created_at: utcNow(),
      ordinal: int(ordinalRow ?? {next_ordinal: 1}, "next_ordinal"),
    };
    querySync(
      this.pool,
      `
      insert into events(event_id, run_id, event_type, payload_json, created_at, ordinal)
      values ($1, $2, $3, $4, $5, $6)
      `,
      [
        event.event_id,
        event.run_id,
        event.event_type,
        jsonDump(event.payload ?? {}),
        event.created_at,
        event.ordinal,
      ],
    );
    return event;
  }

  list_events(runId: string): SSEEvent[] {
    const rows = queryRows(
      this.pool,
      "select * from events where run_id = $1 order by ordinal asc",
      [runId],
    );
    return rows.map((row) => this.eventFromRow(row));
  }

  list_events_after(runId: string, ordinal: number): SSEEvent[] {
    const rows = queryRows(
      this.pool,
      `
      select * from events
      where run_id = $1 and ordinal > $2
      order by ordinal asc
      `,
      [runId, ordinal],
    );
    return rows.map((row) => this.eventFromRow(row));
  }

  private eventFromRow(row: SqlRow): SSEEvent {
    return {
      event_id: str(row, "event_id"),
      run_id: str(row, "run_id"),
      event_type: str(row, "event_type"),
      payload: jsonLoad(str(row, "payload_json")),
      created_at: str(row, "created_at"),
      ordinal: int(row, "ordinal"),
    };
  }

  insert_artifact(metadata: ArtifactMetadata): void {
    querySync(
      this.pool,
      `
      insert into artifacts(artifact_id, run_id, artifact_type, status, title, path,
                            metadata_path, schema_version, trace_refs_json, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      on conflict(artifact_id) do update set
          run_id = excluded.run_id,
          artifact_type = excluded.artifact_type,
          status = excluded.status,
          title = excluded.title,
          path = excluded.path,
          metadata_path = excluded.metadata_path,
          schema_version = excluded.schema_version,
          trace_refs_json = excluded.trace_refs_json,
          created_at = excluded.created_at
      `,
      [
        metadata.artifact_id,
        metadata.source_run_id,
        metadata.artifact_type,
        metadata.status,
        metadata.title,
        metadata.path,
        metadata.metadata_path,
        metadata.schema_version,
        jsonDump({trace_refs: metadata.trace_refs ?? []}),
        metadata.created_at,
      ],
    );
  }

  latest_artifact_by_type(threadId: string, artifactType: string): ArtifactMetadata | null {
    return this.latest_artifact_for_thread(threadId, artifactType);
  }

  count_thread_artifacts(threadId: string, artifactType: string): number {
    this.ensure_initialized();
    const row = queryOne(
      this.pool,
      `
      select count(*) as count
      from artifacts
      join runs on runs.run_id = artifacts.run_id
      where runs.thread_id = $1 and artifacts.artifact_type = $2
      `,
      [threadId, artifactType],
    );
    return row ? int(row, "count") : 0;
  }

  count_open_disagreements(threadId: string, impactLevel: string): number {
    const logs = this.latest_artifacts_for_thread(threadId, "DisagreementLog", 50);
    let count = 0;
    for (const meta of logs) {
      try {
        const payload: unknown = JSON.parse(fs.readFileSync(meta.metadata_path, "utf8"));
        const record = payload as {log?: {status?: string; impact_on_idea_version?: string}};
        if (
          record.log?.status === "open" &&
          record.log?.impact_on_idea_version === impactLevel
        ) {
          count += 1;
        }
      } catch {
        // skip corrupt metadata
      }
    }
    return count;
  }

  latest_artifact_for_thread(
    threadId: string,
    artifactType = "ResearchIdeaPlanDraft",
  ): ArtifactMetadata | null {
    this.ensure_initialized();
    const row = queryOne(
      this.pool,
      `
      select artifacts.*
      from artifacts
      join runs on runs.run_id = artifacts.run_id
      where runs.thread_id = $1 and artifacts.artifact_type = $2
      order by artifacts.created_at desc
      limit 1
      `,
      [threadId, artifactType],
    );
    if (row === undefined) {
      return null;
    }
    return this.artifactFromRow(row);
  }

  latest_artifacts_for_thread(
    threadId: string,
    artifactType: string,
    limit = 5,
  ): ArtifactMetadata[] {
    this.ensure_initialized();
    const rows = queryRows(
      this.pool,
      `
      select artifacts.*
      from artifacts
      join runs on runs.run_id = artifacts.run_id
      where runs.thread_id = $1 and artifacts.artifact_type = $2
      order by artifacts.created_at desc
      limit $3
      `,
      [threadId, artifactType, limit],
    );
    return rows.map((row) => this.artifactFromRow(row));
  }

  latest_plan_artifact_for_thread(threadId: string): ArtifactMetadata | null {
    this.ensure_initialized();
    const row = queryOne(
      this.pool,
      `
      select artifacts.*
      from artifacts
      join runs on runs.run_id = artifacts.run_id
      where runs.thread_id = $1
        and artifacts.artifact_type in ('ResearchIdeaPlan', 'ResearchIdeaPlanDraft')
      order by case artifacts.artifact_type
          when 'ResearchIdeaPlan' then 0
          else 1
      end, artifacts.created_at desc
      limit 1
      `,
      [threadId],
    );
    if (row === undefined) {
      return null;
    }
    return this.artifactFromRow(row);
  }

  thread_session_status(threadId: string): string {
    const artifact = this.latest_plan_artifact_for_thread(threadId);
    if (artifact === null) {
      return "needs literature";
    }
    return sessionStatusFromArtifact(
      artifact.artifact_type,
      artifact.status,
      this.latest_idea_review(threadId) !== null,
    );
  }

  update_thread_workflow(
    threadId: string,
    patch: Partial<
      Pick<WorkflowThread, "current_mode" | "lifecycle_state" | "idea_version" | "impact_level">
    >,
  ): WorkflowThread {
    this.ensure_initialized();
    if (patch.current_mode !== undefined) {
      querySync(this.pool, "update threads set current_mode = $1 where thread_id = $2", [
        patch.current_mode,
        threadId,
      ]);
    }
    if (patch.lifecycle_state !== undefined) {
      querySync(this.pool, "update threads set lifecycle_state = $1 where thread_id = $2", [
        patch.lifecycle_state,
        threadId,
      ]);
    }
    if (patch.idea_version !== undefined) {
      querySync(this.pool, "update threads set idea_version = $1 where thread_id = $2", [
        patch.idea_version,
        threadId,
      ]);
    }
    if (patch.impact_level !== undefined) {
      querySync(this.pool, "update threads set impact_level = $1 where thread_id = $2", [
        patch.impact_level,
        threadId,
      ]);
    }
    return this.get_thread(threadId);
  }

  record_idea_review(
    threadId: string,
    artifactId: string,
    runId: string,
    decision: string,
    notes?: string | null,
    scores?: Record<string, number> | null,
    confidence?: string | null,
  ): Record<string, unknown> {
    this.ensure_initialized();
    const review: Record<string, unknown> = {
      review_id: newId("review"),
      thread_id: threadId,
      artifact_id: artifactId,
      run_id: runId,
      decision,
      notes: notes ?? null,
      scores_json: scores ? JSON.stringify(scores) : null,
      confidence: confidence ?? null,
      created_at: utcNow(),
    };
    querySync(
      this.pool,
      `
      insert into idea_reviews(
        review_id, thread_id, artifact_id, run_id,
        decision, notes, scores_json, confidence, created_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        review.review_id,
        review.thread_id,
        review.artifact_id,
        review.run_id,
        review.decision,
        review.notes,
        review.scores_json,
        review.confidence,
        review.created_at,
      ],
    );
    return review;
  }

  record_blueprint_review(
    threadId: string,
    artifactId: string,
    runId: string,
    decision: string,
    notes?: string | null,
  ): Record<string, unknown> {
    this.ensure_initialized();
    const review: Record<string, unknown> = {
      review_id: newId("blueprint_review"),
      thread_id: threadId,
      artifact_id: artifactId,
      run_id: runId,
      decision,
      notes: notes ?? null,
      created_at: utcNow(),
    };
    querySync(
      this.pool,
      `
      insert into blueprint_reviews(review_id, thread_id, artifact_id, run_id, decision, notes, created_at)
      values ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        review.review_id,
        review.thread_id,
        review.artifact_id,
        review.run_id,
        review.decision,
        review.notes,
        review.created_at,
      ],
    );
    return review;
  }

  latest_blueprint_review(threadId: string): Record<string, unknown> | null {
    this.ensure_initialized();
    const row = queryOne(
      this.pool,
      `
      select * from blueprint_reviews
      where thread_id = $1
      order by created_at desc
      limit 1
      `,
      [threadId],
    );
    return row ? {...row} : null;
  }

  latest_idea_review(threadId: string): Record<string, unknown> | null {
    this.ensure_initialized();
    const row = queryOne(
      this.pool,
      `
      select *
      from idea_reviews
      where thread_id = $1
      order by created_at desc
      limit 1
      `,
      [threadId],
    );
    return row ? {...row} : null;
  }

  list_idea_reviews(threadId: string): Record<string, unknown>[] {
    this.ensure_initialized();
    const rows = queryRows(
      this.pool,
      `
      select *
      from idea_reviews
      where thread_id = $1
      order by created_at desc
      `,
      [threadId],
    );
    return rows.map((row) => ({...row}));
  }

  upsert_memory_record(record: MemoryRecord): void {
    this.ensure_initialized();
    querySync(
      this.pool,
      `
      insert into memory_records(record_id, thread_id, record_type, title, summary,
                                 source_refs_json, artifact_refs_json, status,
                                 importance, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      on conflict(record_id) do update set
          thread_id = excluded.thread_id,
          record_type = excluded.record_type,
          title = excluded.title,
          summary = excluded.summary,
          source_refs_json = excluded.source_refs_json,
          artifact_refs_json = excluded.artifact_refs_json,
          status = excluded.status,
          importance = excluded.importance,
          updated_at = excluded.updated_at
      `,
      [
        record.record_id,
        record.thread_id ?? null,
        record.record_type,
        record.title,
        record.summary,
        jsonDump({source_refs: record.source_refs ?? []}),
        jsonDump({artifact_refs: record.artifact_refs ?? []}),
        record.status ?? "active",
        record.importance ?? 0,
        record.created_at,
        record.updated_at,
      ],
    );
  }

  update_memory_record_status(
    recordId: string,
    status: string,
    updatedAt?: string | null,
  ): void {
    this.ensure_initialized();
    querySync(
      this.pool,
      `
      update memory_records
      set status = $1, updated_at = $2
      where record_id = $3
      `,
      [status, updatedAt ?? utcNow(), recordId],
    );
  }

  list_memory_records(
    threadId?: string | null,
    recordType?: string | null,
    limit = 100,
  ): MemoryRecord[] {
    this.ensure_initialized();
    const filters: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;
    if (threadId !== undefined && threadId !== null) {
      filters.push(`thread_id = $${paramIndex++}`);
      params.push(threadId);
    }
    if (recordType !== undefined && recordType !== null) {
      filters.push(`record_type = $${paramIndex++}`);
      params.push(recordType);
    }
    const whereClause = filters.length > 0 ? `where ${filters.join(" and ")}` : "";
    params.push(limit);
    const rows = queryRows(
      this.pool,
      `
      select *
      from memory_records
      ${whereClause}
      order by importance desc, updated_at desc
      limit $${paramIndex}
      `,
      params,
    );
    return rows.map((row) => this.memoryRecordFromRow(row));
  }

  upsert_memory_index(
    recordId: string,
    searchText: string,
    embedding: Record<string, number>,
    sourceHash: string,
    updatedAt?: string | null,
  ): void {
    this.ensure_initialized();
    querySync(
      this.pool,
      `
      insert into memory_index(record_id, search_text, embedding_json,
                               source_hash, updated_at)
      values ($1, $2, $3, $4, $5)
      on conflict(record_id) do update set
          search_text = excluded.search_text,
          embedding_json = excluded.embedding_json,
          source_hash = excluded.source_hash,
          updated_at = excluded.updated_at
      `,
      [
        recordId,
        searchText,
        jsonDump({embedding}),
        sourceHash,
        updatedAt ?? utcNow(),
      ],
    );
  }

  list_memory_index(): Record<string, Record<string, unknown>> {
    this.ensure_initialized();
    const rows = queryRows(this.pool, "select * from memory_index");
    const index: Record<string, Record<string, unknown>> = {};
    for (const row of rows) {
      const recordId = str(row, "record_id");
      index[recordId] = {
        search_text: str(row, "search_text"),
        embedding: jsonLoad(str(row, "embedding_json")).embedding ?? {},
        source_hash: str(row, "source_hash"),
        updated_at: str(row, "updated_at"),
      };
    }
    return index;
  }

  upsert_conflict_record(conflict: ConflictRecord): void {
    this.ensure_initialized();
    querySync(
      this.pool,
      `
      insert into conflict_records(conflict_id, thread_id, conflict_type, status,
                                   summary, record_refs_json, source_refs_json,
                                   created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      on conflict(conflict_id) do update set
          thread_id = excluded.thread_id,
          conflict_type = excluded.conflict_type,
          status = excluded.status,
          summary = excluded.summary,
          record_refs_json = excluded.record_refs_json,
          source_refs_json = excluded.source_refs_json,
          updated_at = excluded.updated_at
      `,
      [
        conflict.conflict_id,
        conflict.thread_id ?? null,
        conflict.conflict_type,
        conflict.status ?? "open",
        conflict.summary,
        jsonDump({record_refs: conflict.record_refs ?? []}),
        jsonDump({source_refs: conflict.source_refs ?? []}),
        conflict.created_at,
        conflict.updated_at,
      ],
    );
  }

  list_conflict_records(
    threadId?: string | null,
    status?: string | null,
    limit = 100,
  ): ConflictRecord[] {
    this.ensure_initialized();
    const filters: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;
    if (threadId !== undefined && threadId !== null) {
      filters.push(`thread_id = $${paramIndex++}`);
      params.push(threadId);
    }
    if (status !== undefined && status !== null) {
      filters.push(`status = $${paramIndex++}`);
      params.push(status);
    }
    const whereClause = filters.length > 0 ? `where ${filters.join(" and ")}` : "";
    params.push(limit);
    const rows = queryRows(
      this.pool,
      `
      select *
      from conflict_records
      ${whereClause}
      order by updated_at desc
      limit $${paramIndex}
      `,
      params,
    );
    return rows.map((row) => this.conflictRecordFromRow(row));
  }

  private conflictRecordFromRow(row: SqlRow): ConflictRecord {
    return {
      conflict_id: str(row, "conflict_id"),
      thread_id: strOrNull(row, "thread_id"),
      conflict_type: str(row, "conflict_type") as ConflictRecord["conflict_type"],
      status: str(row, "status") as ConflictRecord["status"],
      summary: str(row, "summary"),
      record_refs: (jsonLoad(str(row, "record_refs_json")).record_refs as string[] | undefined) ?? [],
      source_refs: (jsonLoad(str(row, "source_refs_json")).source_refs as string[] | undefined) ?? [],
      created_at: str(row, "created_at"),
      updated_at: str(row, "updated_at"),
    };
  }

  private memoryRecordFromRow(row: SqlRow): MemoryRecord {
    return {
      record_id: str(row, "record_id"),
      thread_id: strOrNull(row, "thread_id"),
      record_type: str(row, "record_type") as MemoryRecord["record_type"],
      title: str(row, "title"),
      summary: str(row, "summary"),
      source_refs: (jsonLoad(str(row, "source_refs_json")).source_refs as string[] | undefined) ?? [],
      artifact_refs:
        (jsonLoad(str(row, "artifact_refs_json")).artifact_refs as string[] | undefined) ?? [],
      status: str(row, "status") as MemoryRecord["status"],
      importance: int(row, "importance"),
      created_at: str(row, "created_at"),
      updated_at: str(row, "updated_at"),
    };
  }

  private artifactFromRow(row: SqlRow): ArtifactMetadata {
    return {
      artifact_id: str(row, "artifact_id"),
      artifact_type: str(row, "artifact_type") as ArtifactMetadata["artifact_type"],
      status: str(row, "status") as ArtifactMetadata["status"],
      title: str(row, "title"),
      path: str(row, "path"),
      metadata_path: str(row, "metadata_path"),
      schema_version: str(row, "schema_version"),
      source_run_id: str(row, "run_id"),
      trace_refs: (jsonLoad(str(row, "trace_refs_json")).trace_refs as string[] | undefined) ?? [],
      created_at: str(row, "created_at"),
    };
  }

  get_artifact_metadata(artifactId: string): ArtifactMetadata {
    const row = queryOne(this.pool, "select * from artifacts where artifact_id = $1", [
      artifactId,
    ]);
    if (row === undefined) {
      throw new KeyError(`Unknown artifact: ${artifactId}`);
    }
    return this.artifactFromRow(row);
  }

  insert_trace(trace: TraceRecord): void {
    querySync(
      this.pool,
      `
      insert into traces(trace_id, run_id, trace_type, path, payload_hash, created_at)
      values ($1, $2, $3, $4, $5, $6)
      `,
      [
        trace.trace_id,
        trace.run_id,
        trace.trace_type,
        trace.path,
        trace.payload_hash,
        trace.created_at,
      ],
    );
  }

  get_trace(traceId: string): TraceRecord {
    const row = queryOne(this.pool, "select * from traces where trace_id = $1", [traceId]);
    if (row === undefined) {
      throw new KeyError(`Unknown trace: ${traceId}`);
    }
    return {
      trace_id: str(row, "trace_id"),
      run_id: str(row, "run_id"),
      trace_type: str(row, "trace_type"),
      path: str(row, "path"),
      payload_hash: str(row, "payload_hash"),
      created_at: str(row, "created_at"),
    };
  }

  get_app_cache_record(cacheKey: string): AppCacheRecord | null {
    const row = queryOne(this.pool, "select * from app_cache where cache_key = $1", [cacheKey]);
    if (row === undefined) {
      return null;
    }
    return {
      cache_key: str(row, "cache_key"),
      cache_type: str(row, "cache_type"),
      provider: str(row, "provider") as AppCacheRecord["provider"],
      model: str(row, "model"),
      profile: str(row, "profile") as AppCacheRecord["profile"],
      prompt_version: str(row, "prompt_version"),
      input_hash: str(row, "input_hash"),
      payload_json: jsonLoad(str(row, "payload_json")),
      created_at: str(row, "created_at"),
    };
  }

  list_app_cache_records(limit = 50): AppCacheSummaryRecord[] {
    this.ensure_initialized();
    const rows = queryRows(
      this.pool,
      `
      select cache_key, cache_type, provider, model, profile, prompt_version,
             input_hash, created_at
      from app_cache
      order by created_at desc
      limit $1
      `,
      [limit],
    );
    return rows.map((row) => ({
      cache_key: str(row, "cache_key"),
      cache_type: str(row, "cache_type"),
      provider: str(row, "provider") as AppCacheSummaryRecord["provider"],
      model: str(row, "model"),
      profile: str(row, "profile") as AppCacheSummaryRecord["profile"],
      prompt_version: str(row, "prompt_version"),
      input_hash: str(row, "input_hash"),
      created_at: str(row, "created_at"),
    }));
  }

  clear_app_cache_records(): number {
    this.ensure_initialized();
    const result = querySync(this.pool, "delete from app_cache");
    return result.rowCount ?? 0;
  }

  upsert_app_cache_record(record: AppCacheRecord): void {
    querySync(
      this.pool,
      `
      insert into app_cache(cache_key, cache_type, provider, model, profile,
                           prompt_version, input_hash, payload_json, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      on conflict(cache_key) do update set
          cache_type = excluded.cache_type,
          provider = excluded.provider,
          model = excluded.model,
          profile = excluded.profile,
          prompt_version = excluded.prompt_version,
          input_hash = excluded.input_hash,
          payload_json = excluded.payload_json,
          created_at = excluded.created_at
      `,
      [
        record.cache_key,
        record.cache_type,
        record.provider,
        record.model,
        record.profile,
        record.prompt_version,
        record.input_hash,
        jsonDump(record.payload_json),
        record.created_at,
      ],
    );
  }

  private readingRequestPath(threadId: string): string {
    const dir = path.join(this.workspaceDir, "thread-state");
    fs.mkdirSync(dir, {recursive: true});
    return path.join(dir, `${threadId}.reading.json`);
  }

  set_reading_request(
    threadId: string,
    request: {mode: "quick" | "guided" | "exam"; paper_id: string; query?: string},
  ): void {
    this.ensure_initialized();
    this.get_thread(threadId);
    fs.writeFileSync(this.readingRequestPath(threadId), JSON.stringify(request, null, 2) + "\n", "utf8");
  }

  get_reading_request(
    threadId: string,
  ): {mode: "quick" | "guided" | "exam"; paper_id: string; query?: string} | null {
    this.ensure_initialized();
    const filePath = this.readingRequestPath(threadId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const payload: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const record = payload as {mode?: string; paper_id?: string; query?: string};
    if (!record.paper_id || !record.mode) {
      return null;
    }
    return {
      mode: record.mode as "quick" | "guided" | "exam",
      paper_id: String(record.paper_id),
      query: record.query ? String(record.query) : undefined,
    };
  }

  clear_reading_request(threadId: string): void {
    const filePath = this.readingRequestPath(threadId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
