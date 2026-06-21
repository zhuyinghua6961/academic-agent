import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { renderDefaultProjectConfig } from "@academic-agent/config";
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
import Database from "better-sqlite3";

const REQUIRED_DIRS = ["artifacts", "traces", "memory", "cache"] as const;

type SqlRow = Record<string, unknown>;
type MessageRole = ThreadMessage["role"];

function projectId(projectRoot: string): string {
  const digest = createHash("sha256").update(projectRoot, "utf8").digest("hex").slice(0, 12);
  return `project_${digest}`;
}

function jsonDump(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function jsonLoad(payload: string | null | undefined): Record<string, unknown> {
  if (!payload) {
    return {};
  }
  const loaded: unknown = JSON.parse(payload);
  return typeof loaded === "object" && loaded !== null && !Array.isArray(loaded)
    ? (loaded as Record<string, unknown>)
    : {};
}

function defaultThreadTitle(threadId: string): string {
  return `Untitled ${threadId.slice(-6)}`;
}

function sessionStatusFromArtifact(
  artifactType: string | null | undefined,
  artifactStatus: string | null | undefined,
  hasReview = false,
): string {
  if (artifactType === "ResearchIdeaPlan" || artifactStatus === "frozen") {
    return "frozen";
  }
  if (hasReview) {
    return "reviewed";
  }
  if (artifactType === "ResearchIdeaPlanDraft") {
    return "draft";
  }
  return "needs literature";
}

function str(row: SqlRow, key: string): string {
  return String(row[key]);
}

function strOrNull(row: SqlRow, key: string): string | null {
  const value = row[key];
  return value == null ? null : String(value);
}

function int(row: SqlRow, key: string): number {
  return Number(row[key]);
}

function bool(row: SqlRow, key: string): boolean {
  return Boolean(row[key]);
}

export class ProjectWorkspace {
  readonly projectRoot: string;
  readonly workspaceDir: string;
  readonly dbPath: string;
  readonly projectId: string;

  constructor(projectRoot?: string | null) {
    const envRoot = process.env.ACADEMIC_AGENT_PROJECT_ROOT;
    const root = projectRoot ?? envRoot ?? process.cwd();
    this.projectRoot = path.resolve(root);
    this.workspaceDir = path.join(this.projectRoot, ".academic-agent");
    this.dbPath = path.join(this.workspaceDir, "academic-agent.sqlite3");
    this.projectId = projectId(this.projectRoot);
  }

  get directories(): string[] {
    return REQUIRED_DIRS.map((name) => path.join(this.workspaceDir, name));
  }

  init(): ProjectStatus {
    fs.mkdirSync(this.workspaceDir, { recursive: true });
    for (const directory of this.directories) {
      fs.mkdirSync(directory, { recursive: true });
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

    const conn = this.connect();
    try {
      this._init_db(conn);
      this._migrate_db(conn);
      conn
        .prepare(
          `
          insert or ignore into projects(project_id, project_root, workspace_dir, created_at)
          values (?, ?, ?, ?)
          `,
        )
        .run(this.projectId, this.projectRoot, this.workspaceDir, utcNow());
    } finally {
      conn.close();
    }

    return this.status();
  }

  status(): ProjectStatus {
    const initialized =
      fs.existsSync(this.dbPath) && this.directories.every((dirPath) => fs.existsSync(dirPath));
    return {
      project_id: this.projectId,
      project_root: this.projectRoot,
      workspace_dir: this.workspaceDir,
      db_path: this.dbPath,
      initialized,
      directories: this.directories,
    };
  }

  connect(): Database.Database {
    fs.mkdirSync(this.workspaceDir, { recursive: true });
    return new Database(this.dbPath);
  }

  _init_db(conn: Database.Database): void {
    conn.exec(`
      create table if not exists projects(
          project_id text primary key,
          project_root text not null,
          workspace_dir text not null,
          created_at text not null
      );

      create table if not exists threads(
          thread_id text primary key,
          project_id text not null,
          name text,
          created_at text not null
      );

      create table if not exists runs(
          run_id text primary key,
          thread_id text not null,
          mode text not null,
          status text not null,
          input_idea text not null,
          artifact_id text,
          error text,
          created_at text not null,
          updated_at text not null
      );

      create table if not exists messages(
          message_id text primary key,
          thread_id text not null,
          role text not null,
          content text not null,
          run_id text,
          created_at text not null,
          ordinal integer not null,
          tool_call_id text,
          tool_name text,
          tool_args_json text,
          parent_message_id text
      );

      create table if not exists events(
          event_id text primary key,
          run_id text not null,
          event_type text not null,
          payload_json text not null,
          created_at text not null,
          ordinal integer not null
      );

      create table if not exists artifacts(
          artifact_id text primary key,
          run_id text not null,
          artifact_type text not null,
          status text not null,
          title text not null,
          path text not null,
          metadata_path text not null,
          schema_version text not null,
          trace_refs_json text not null,
          created_at text not null
      );

      create table if not exists traces(
          trace_id text primary key,
          run_id text not null,
          trace_type text not null,
          path text not null,
          payload_hash text not null,
          created_at text not null
      );

      create table if not exists app_cache(
          cache_key text primary key,
          cache_type text not null,
          provider text not null,
          model text not null,
          profile text not null,
          prompt_version text not null,
          input_hash text not null,
          payload_json text not null,
          created_at text not null
      );

      create table if not exists idea_reviews(
          review_id text primary key,
          thread_id text not null,
          artifact_id text not null,
          run_id text not null,
          decision text not null,
          notes text,
          created_at text not null
      );

      create table if not exists memory_records(
          record_id text primary key,
          thread_id text,
          record_type text not null,
          title text not null,
          summary text not null,
          source_refs_json text not null,
          artifact_refs_json text not null,
          status text not null,
          importance integer not null,
          created_at text not null,
          updated_at text not null
      );

      create table if not exists memory_index(
          record_id text primary key,
          search_text text not null,
          embedding_json text not null,
          source_hash text not null,
          updated_at text not null
      );

      create table if not exists conflict_records(
          conflict_id text primary key,
          thread_id text,
          conflict_type text not null,
          status text not null,
          summary text not null,
          record_refs_json text not null,
          source_refs_json text not null,
          created_at text not null,
          updated_at text not null
      );
    `);
  }

  _migrate_db(conn: Database.Database): void {
    const columns = new Set(
      (conn.prepare("pragma table_info(threads)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!columns.has("name")) {
      conn.exec("alter table threads add column name text");
    }
    if (!columns.has("current_mode")) {
      conn.exec("alter table threads add column current_mode text not null default 'idea_plan'");
    }
    if (!columns.has("lifecycle_state")) {
      conn.exec(
        "alter table threads add column lifecycle_state text not null default 'lightweight_diagnosis'",
      );
    }
    if (!columns.has("idea_version")) {
      conn.exec("alter table threads add column idea_version integer not null default 1");
    }
    if (!columns.has("impact_level")) {
      conn.exec("alter table threads add column impact_level text not null default 'None'");
    }
    conn.exec(`
      create unique index if not exists threads_project_name_unique
      on threads(project_id, name)
    `);

    const reviewColumns = new Set(
      (conn.prepare("pragma table_info(idea_reviews)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!reviewColumns.has("scores_json")) {
      conn.exec("alter table idea_reviews add column scores_json text");
    }
    if (!reviewColumns.has("confidence")) {
      conn.exec("alter table idea_reviews add column confidence text");
    }

    conn.exec(`
      create table if not exists blueprint_reviews(
          review_id text primary key,
          thread_id text not null,
          artifact_id text not null,
          run_id text not null,
          decision text not null,
          notes text,
          created_at text not null
      )
    `);

    const messagesColumns = new Set(
      (conn.prepare("pragma table_info(messages)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    for (const col of ["tool_call_id", "tool_name", "tool_args_json", "parent_message_id"]) {
      if (!messagesColumns.has(col)) {
        conn.exec(`alter table messages add column ${col} text`);
      }
    }
  }

  ensure_initialized(): void {
    if (!this.status().initialized) {
      this.init();
    }
  }

  _thread_from_row(row: SqlRow): WorkflowThread {
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
    const conn = this.connect();
    let row: SqlRow | undefined;
    try {
      row = conn
        .prepare(`${ProjectWorkspace.THREAD_SELECT} where thread_id = ?`)
        .get(threadId) as SqlRow | undefined;
    } finally {
      conn.close();
    }
    if (row === undefined) {
      throw new KeyError(`Unknown thread: ${threadId}`);
    }
    return this._thread_from_row(row);
  }

  list_threads(limit = 50, includeEmpty = true): WorkflowThread[] {
    this.ensure_initialized();
    const messageFilter = includeEmpty
      ? ""
      : "where exists (select 1 from messages where messages.thread_id = threads.thread_id)";
    const conn = this.connect();
    let rows: SqlRow[];
    try {
      rows = conn
        .prepare(
          `
          select thread_id, project_id, name, created_at, current_mode, lifecycle_state, idea_version, impact_level
          from threads
          ${messageFilter}
          order by created_at desc
          limit ?
          `,
        )
        .all(limit) as SqlRow[];
    } finally {
      conn.close();
    }
    return rows.map((row) => this._thread_from_row(row));
  }

  list_thread_sessions(limit = 50): ThreadSessionSummary[] {
    this.ensure_initialized();
    const conn = this.connect();
    let rows: SqlRow[];
    try {
      rows = conn
        .prepare(
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
          group by threads.thread_id
          order by coalesce(last_message_at, last_run_at, threads.created_at) desc
          limit ?
          `,
        )
        .all(limit) as SqlRow[];
    } finally {
      conn.close();
    }
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
    const conn = this.connect();
    let row: SqlRow | undefined;
    try {
      row = conn
        .prepare(
          `
          select thread_id, project_id, name, created_at, current_mode, lifecycle_state, idea_version, impact_level
          from threads
          where project_id = ? and name = ?
          `,
        )
        .get(this.projectId, normalized) as SqlRow | undefined;
    } finally {
      conn.close();
    }
    if (row === undefined) {
      throw new KeyError(`Unknown thread name: ${normalized}`);
    }
    return this._thread_from_row(row);
  }

  rename_thread(threadId: string, name: string): WorkflowThread {
    this.ensure_initialized();
    const normalized = name.trim();
    if (!normalized) {
      throw new Error("Thread name cannot be empty");
    }
    const conn = this.connect();
    try {
      const current = conn
        .prepare("select thread_id from threads where thread_id = ?")
        .get(threadId) as SqlRow | undefined;
      if (current === undefined) {
        throw new KeyError(`Unknown thread: ${threadId}`);
      }
      const conflict = conn
        .prepare(
          `
          select thread_id
          from threads
          where project_id = ? and name = ? and thread_id != ?
          `,
        )
        .get(this.projectId, normalized, threadId) as SqlRow | undefined;
      if (conflict !== undefined) {
        throw new Error(`Thread name already exists: ${normalized}`);
      }
      conn
        .prepare(
          `
          update threads
          set name = ?
          where thread_id = ?
          `,
        )
        .run(normalized, threadId);
    } finally {
      conn.close();
    }
    return this.get_thread(threadId);
  }

  create_thread(threadId?: string | null, name?: string | null): WorkflowThread {
    this.ensure_initialized();
    const now = utcNow();
    const nextThreadId = threadId ?? newId("thread");
    let existing: SqlRow | undefined;
    if (threadId !== undefined && threadId !== null) {
      const conn = this.connect();
      try {
        existing = conn
          .prepare(`${ProjectWorkspace.THREAD_SELECT} where thread_id = ?`)
          .get(threadId) as SqlRow | undefined;
      } finally {
        conn.close();
      }
    }
    if (existing !== undefined) {
      return this._thread_from_row(existing);
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
    const conn = this.connect();
    try {
      conn
        .prepare(
          `
          insert or ignore into threads(
            thread_id, project_id, name, created_at,
            current_mode, lifecycle_state, idea_version, impact_level
          )
          values (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          thread.thread_id,
          thread.project_id,
          thread.name,
          thread.created_at,
          thread.current_mode,
          thread.lifecycle_state,
          thread.idea_version,
          thread.impact_level,
        );
    } finally {
      conn.close();
    }
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
    const conn = this.connect();
    try {
      const ordinalRow = conn
        .prepare(
          "select coalesce(max(ordinal), 0) + 1 as next_ordinal from messages where thread_id = ?",
        )
        .get(threadId) as SqlRow;
      const message: ThreadMessage = {
        message_id: newId("msg"),
        thread_id: threadId,
        role: messageRole,
        content,
        run_id: runId ?? null,
        created_at: utcNow(),
        ordinal: int(ordinalRow, "next_ordinal"),
        tool_call_id: toolCallId ?? null,
        tool_name: toolName ?? null,
        tool_args: toolArgs ?? null,
        parent_message_id: parentMessageId ?? null,
      };
      conn
        .prepare(
          `
          insert into messages(message_id, thread_id, role, content, run_id,
                               created_at, ordinal, tool_call_id, tool_name,
                               tool_args_json, parent_message_id)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
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
        );
      return message;
    } finally {
      conn.close();
    }
  }

  list_messages(threadId: string): ThreadMessage[] {
    this.ensure_initialized();
    const conn = this.connect();
    let rows: SqlRow[];
    try {
      rows = conn
        .prepare("select * from messages where thread_id = ? order by ordinal asc")
        .all(threadId) as SqlRow[];
    } finally {
      conn.close();
    }
    return rows.map((row) => ({
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
    }));
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
    const conn = this.connect();
    try {
      conn
        .prepare(
          `
          insert into runs(run_id, thread_id, mode, status, input_idea, artifact_id, error,
                           created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          run.run_id,
          run.thread_id,
          run.mode,
          run.status,
          run.input_idea,
          run.artifact_id,
          run.error,
          run.created_at,
          run.updated_at,
        );
    } finally {
      conn.close();
    }
    return run;
  }

  update_run(
    runId: string,
    status: ModeRun["status"],
    artifactId?: string | null,
    error?: string | null,
  ): ModeRun {
    const now = utcNow();
    const conn = this.connect();
    try {
      const existing = conn
        .prepare("select artifact_id from runs where run_id = ?")
        .get(runId) as SqlRow | undefined;
      if (existing === undefined) {
        throw new KeyError(`Unknown run: ${runId}`);
      }
      const nextArtifactId =
        artifactId !== undefined && artifactId !== null
          ? artifactId
          : strOrNull(existing, "artifact_id");
      conn
        .prepare(
          `
          update runs
          set status = ?, artifact_id = ?, error = ?, updated_at = ?
          where run_id = ?
          `,
        )
        .run(status, nextArtifactId, error ?? null, now, runId);
    } finally {
      conn.close();
    }
    return this.get_run(runId);
  }

  get_run(runId: string): ModeRun {
    const conn = this.connect();
    let row: SqlRow | undefined;
    try {
      row = conn.prepare("select * from runs where run_id = ?").get(runId) as SqlRow | undefined;
    } finally {
      conn.close();
    }
    if (row === undefined) {
      throw new KeyError(`Unknown run: ${runId}`);
    }
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
    const conn = this.connect();
    let rows: SqlRow[];
    try {
      rows = conn
        .prepare(
          `
          select * from runs
          order by created_at desc
          limit ?
          `,
        )
        .all(limit) as SqlRow[];
    } finally {
      conn.close();
    }
    return rows.map((row) => ({
      run_id: str(row, "run_id"),
      thread_id: str(row, "thread_id"),
      mode: str(row, "mode") as ModeRun["mode"],
      status: str(row, "status") as ModeRun["status"],
      input_idea: str(row, "input_idea"),
      artifact_id: strOrNull(row, "artifact_id"),
      error: strOrNull(row, "error"),
      created_at: str(row, "created_at"),
      updated_at: str(row, "updated_at"),
    }));
  }

  add_event(
    runId: string,
    eventType: string,
    payload?: Record<string, unknown> | null,
  ): SSEEvent {
    this.ensure_initialized();
    const conn = this.connect();
    try {
      const ordinalRow = conn
        .prepare("select coalesce(max(ordinal), 0) + 1 as next_ordinal from events where run_id = ?")
        .get(runId) as SqlRow;
      const event: SSEEvent = {
        event_id: newId("evt"),
        run_id: runId,
        event_type: eventType,
        payload: payload ?? {},
        created_at: utcNow(),
        ordinal: int(ordinalRow, "next_ordinal"),
      };
      conn
        .prepare(
          `
          insert into events(event_id, run_id, event_type, payload_json, created_at, ordinal)
          values (?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          event.event_id,
          event.run_id,
          event.event_type,
          jsonDump(event.payload ?? {}),
          event.created_at,
          event.ordinal,
        );
      return event;
    } finally {
      conn.close();
    }
  }

  list_events(runId: string): SSEEvent[] {
    const conn = this.connect();
    let rows: SqlRow[];
    try {
      rows = conn
        .prepare("select * from events where run_id = ? order by ordinal asc")
        .all(runId) as SqlRow[];
    } finally {
      conn.close();
    }
    return rows.map((row) => ({
      event_id: str(row, "event_id"),
      run_id: str(row, "run_id"),
      event_type: str(row, "event_type"),
      payload: jsonLoad(str(row, "payload_json")),
      created_at: str(row, "created_at"),
      ordinal: int(row, "ordinal"),
    }));
  }

  list_events_after(runId: string, ordinal: number): SSEEvent[] {
    const conn = this.connect();
    let rows: SqlRow[];
    try {
      rows = conn
        .prepare(
          `
          select * from events
          where run_id = ? and ordinal > ?
          order by ordinal asc
          `,
        )
        .all(runId, ordinal) as SqlRow[];
    } finally {
      conn.close();
    }
    return rows.map((row) => ({
      event_id: str(row, "event_id"),
      run_id: str(row, "run_id"),
      event_type: str(row, "event_type"),
      payload: jsonLoad(str(row, "payload_json")),
      created_at: str(row, "created_at"),
      ordinal: int(row, "ordinal"),
    }));
  }

  insert_artifact(metadata: ArtifactMetadata): void {
    const conn = this.connect();
    try {
      conn
        .prepare(
          `
          insert into artifacts(artifact_id, run_id, artifact_type, status, title, path,
                                metadata_path, schema_version, trace_refs_json, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        )
        .run(
          metadata.artifact_id,
          metadata.source_run_id,
          metadata.artifact_type,
          metadata.status,
          metadata.title,
          metadata.path,
          metadata.metadata_path,
          metadata.schema_version,
          jsonDump({ trace_refs: metadata.trace_refs ?? [] }),
          metadata.created_at,
        );
    } finally {
      conn.close();
    }
  }

  latest_artifact_by_type(threadId: string, artifactType: string): ArtifactMetadata | null {
    return this.latest_artifact_for_thread(threadId, artifactType);
  }

  count_thread_artifacts(threadId: string, artifactType: string): number {
    this.ensure_initialized();
    const conn = this.connect();
    let row: SqlRow | undefined;
    try {
      row = conn
        .prepare(
          `
          select count(*) as count
          from artifacts
          join runs on runs.run_id = artifacts.run_id
          where runs.thread_id = ? and artifacts.artifact_type = ?
          `,
        )
        .get(threadId, artifactType) as SqlRow | undefined;
    } finally {
      conn.close();
    }
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
    const conn = this.connect();
    let row: SqlRow | undefined;
    try {
      row = conn
        .prepare(
          `
          select artifacts.*
          from artifacts
          join runs on runs.run_id = artifacts.run_id
          where runs.thread_id = ? and artifacts.artifact_type = ?
          order by artifacts.created_at desc
          limit 1
          `,
        )
        .get(threadId, artifactType) as SqlRow | undefined;
    } finally {
      conn.close();
    }
    if (row === undefined) {
      return null;
    }
    return this._artifact_from_row(row);
  }

  latest_artifacts_for_thread(
    threadId: string,
    artifactType: string,
    limit = 5,
  ): ArtifactMetadata[] {
    this.ensure_initialized();
    const conn = this.connect();
    let rows: SqlRow[];
    try {
      rows = conn
        .prepare(
          `
          select artifacts.*
          from artifacts
          join runs on runs.run_id = artifacts.run_id
          where runs.thread_id = ? and artifacts.artifact_type = ?
          order by artifacts.created_at desc
          limit ?
          `,
        )
        .all(threadId, artifactType, limit) as SqlRow[];
    } finally {
      conn.close();
    }
    return rows.map((row) => this._artifact_from_row(row));
  }

  latest_plan_artifact_for_thread(threadId: string): ArtifactMetadata | null {
    this.ensure_initialized();
    const conn = this.connect();
    let row: SqlRow | undefined;
    try {
      row = conn
        .prepare(
          `
          select artifacts.*
          from artifacts
          join runs on runs.run_id = artifacts.run_id
          where runs.thread_id = ?
            and artifacts.artifact_type in ('ResearchIdeaPlan', 'ResearchIdeaPlanDraft')
          order by case artifacts.artifact_type
              when 'ResearchIdeaPlan' then 0
              else 1
          end, artifacts.created_at desc
          limit 1
          `,
        )
        .get(threadId) as SqlRow | undefined;
    } finally {
      conn.close();
    }
    if (row === undefined) {
      return null;
    }
    return this._artifact_from_row(row);
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
    const conn = this.connect();
    try {
      if (patch.current_mode !== undefined) {
        conn.prepare("update threads set current_mode = ? where thread_id = ?").run(
          patch.current_mode,
          threadId,
        );
      }
      if (patch.lifecycle_state !== undefined) {
        conn.prepare("update threads set lifecycle_state = ? where thread_id = ?").run(
          patch.lifecycle_state,
          threadId,
        );
      }
      if (patch.idea_version !== undefined) {
        conn.prepare("update threads set idea_version = ? where thread_id = ?").run(
          patch.idea_version,
          threadId,
        );
      }
      if (patch.impact_level !== undefined) {
        conn.prepare("update threads set impact_level = ? where thread_id = ?").run(
          patch.impact_level,
          threadId,
        );
      }
    } finally {
      conn.close();
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
    const conn = this.connect();
    try {
      conn
        .prepare(
          `
          insert into idea_reviews(
            review_id, thread_id, artifact_id, run_id,
            decision, notes, scores_json, confidence, created_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          review.review_id,
          review.thread_id,
          review.artifact_id,
          review.run_id,
          review.decision,
          review.notes,
          review.scores_json,
          review.confidence,
          review.created_at,
        );
    } finally {
      conn.close();
    }
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
    const conn = this.connect();
    try {
      conn
        .prepare(
          `
          insert into blueprint_reviews(review_id, thread_id, artifact_id, run_id, decision, notes, created_at)
          values (?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          review.review_id,
          review.thread_id,
          review.artifact_id,
          review.run_id,
          review.decision,
          review.notes,
          review.created_at,
        );
    } finally {
      conn.close();
    }
    return review;
  }

  latest_blueprint_review(threadId: string): Record<string, unknown> | null {
    this.ensure_initialized();
    const conn = this.connect();
    let row: SqlRow | undefined;
    try {
      row = conn
        .prepare(
          `
          select * from blueprint_reviews
          where thread_id = ?
          order by created_at desc
          limit 1
          `,
        )
        .get(threadId) as SqlRow | undefined;
    } finally {
      conn.close();
    }
    return row ? {...row} : null;
  }

  latest_idea_review(threadId: string): Record<string, unknown> | null {
    this.ensure_initialized();
    const conn = this.connect();
    let row: SqlRow | undefined;
    try {
      row = conn
        .prepare(
          `
          select *
          from idea_reviews
          where thread_id = ?
          order by created_at desc
          limit 1
          `,
        )
        .get(threadId) as SqlRow | undefined;
    } finally {
      conn.close();
    }
    if (row === undefined) {
      return null;
    }
    return { ...row };
  }

  list_idea_reviews(threadId: string): Record<string, unknown>[] {
    this.ensure_initialized();
    const conn = this.connect();
    let rows: SqlRow[];
    try {
      rows = conn
        .prepare(
          `
          select *
          from idea_reviews
          where thread_id = ?
          order by created_at desc
          `,
        )
        .all(threadId) as SqlRow[];
    } finally {
      conn.close();
    }
    return rows.map((row) => ({ ...row }));
  }

  upsert_memory_record(record: MemoryRecord): void {
    this.ensure_initialized();
    const conn = this.connect();
    try {
      conn
        .prepare(
          `
          insert into memory_records(record_id, thread_id, record_type, title, summary,
                                     source_refs_json, artifact_refs_json, status,
                                     importance, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(record_id) do update set
              thread_id = excluded.thread_id,
              record_type = excluded.record_type,
              title = excluded.title,
              summary = excluded.summary,
              source_refs_json = excluded.source_refs_json,
              artifact_refs_json = excluded.artifact_refs_json,
              status = excluded.status,
              importance = excluded.importance,
              created_at = memory_records.created_at,
              updated_at = excluded.updated_at
          `,
        )
        .run(
          record.record_id,
          record.thread_id ?? null,
          record.record_type,
          record.title,
          record.summary,
          jsonDump({ source_refs: record.source_refs ?? [] }),
          jsonDump({ artifact_refs: record.artifact_refs ?? [] }),
          record.status ?? "active",
          record.importance ?? 0,
          record.created_at,
          record.updated_at,
        );
    } finally {
      conn.close();
    }
  }

  update_memory_record_status(
    recordId: string,
    status: string,
    updatedAt?: string | null,
  ): void {
    this.ensure_initialized();
    const conn = this.connect();
    try {
      conn
        .prepare(
          `
          update memory_records
          set status = ?, updated_at = ?
          where record_id = ?
          `,
        )
        .run(status, updatedAt ?? utcNow(), recordId);
    } finally {
      conn.close();
    }
  }

  list_memory_records(
    threadId?: string | null,
    recordType?: string | null,
    limit = 100,
  ): MemoryRecord[] {
    this.ensure_initialized();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (threadId !== undefined && threadId !== null) {
      filters.push("thread_id = ?");
      params.push(threadId);
    }
    if (recordType !== undefined && recordType !== null) {
      filters.push("record_type = ?");
      params.push(recordType);
    }
    const whereClause = filters.length > 0 ? `where ${filters.join(" and ")}` : "";
    params.push(limit);
    const conn = this.connect();
    let rows: SqlRow[];
    try {
      rows = conn
        .prepare(
          `
          select *
          from memory_records
          ${whereClause}
          order by importance desc, updated_at desc
          limit ?
          `,
        )
        .all(...params) as SqlRow[];
    } finally {
      conn.close();
    }
    return rows.map((row) => this._memory_record_from_row(row));
  }

  upsert_memory_index(
    recordId: string,
    searchText: string,
    embedding: Record<string, number>,
    sourceHash: string,
    updatedAt?: string | null,
  ): void {
    this.ensure_initialized();
    const conn = this.connect();
    try {
      conn
        .prepare(
          `
          insert into memory_index(record_id, search_text, embedding_json,
                                   source_hash, updated_at)
          values (?, ?, ?, ?, ?)
          on conflict(record_id) do update set
              search_text = excluded.search_text,
              embedding_json = excluded.embedding_json,
              source_hash = excluded.source_hash,
              updated_at = excluded.updated_at
          `,
        )
        .run(
          recordId,
          searchText,
          jsonDump({ embedding }),
          sourceHash,
          updatedAt ?? utcNow(),
        );
    } finally {
      conn.close();
    }
  }

  list_memory_index(): Record<string, Record<string, unknown>> {
    this.ensure_initialized();
    const conn = this.connect();
    let rows: SqlRow[];
    try {
      rows = conn.prepare("select * from memory_index").all() as SqlRow[];
    } finally {
      conn.close();
    }
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
    const conn = this.connect();
    try {
      conn
        .prepare(
          `
          insert into conflict_records(conflict_id, thread_id, conflict_type, status,
                                       summary, record_refs_json, source_refs_json,
                                       created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(conflict_id) do update set
              thread_id = excluded.thread_id,
              conflict_type = excluded.conflict_type,
              status = excluded.status,
              summary = excluded.summary,
              record_refs_json = excluded.record_refs_json,
              source_refs_json = excluded.source_refs_json,
              created_at = conflict_records.created_at,
              updated_at = excluded.updated_at
          `,
        )
        .run(
          conflict.conflict_id,
          conflict.thread_id ?? null,
          conflict.conflict_type,
          conflict.status ?? "open",
          conflict.summary,
          jsonDump({ record_refs: conflict.record_refs ?? [] }),
          jsonDump({ source_refs: conflict.source_refs ?? [] }),
          conflict.created_at,
          conflict.updated_at,
        );
    } finally {
      conn.close();
    }
  }

  list_conflict_records(
    threadId?: string | null,
    status?: string | null,
    limit = 100,
  ): ConflictRecord[] {
    this.ensure_initialized();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (threadId !== undefined && threadId !== null) {
      filters.push("thread_id = ?");
      params.push(threadId);
    }
    if (status !== undefined && status !== null) {
      filters.push("status = ?");
      params.push(status);
    }
    const whereClause = filters.length > 0 ? `where ${filters.join(" and ")}` : "";
    params.push(limit);
    const conn = this.connect();
    let rows: SqlRow[];
    try {
      rows = conn
        .prepare(
          `
          select *
          from conflict_records
          ${whereClause}
          order by updated_at desc
          limit ?
          `,
        )
        .all(...params) as SqlRow[];
    } finally {
      conn.close();
    }
    return rows.map((row) => this._conflict_record_from_row(row));
  }

  _conflict_record_from_row(row: SqlRow): ConflictRecord {
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

  _memory_record_from_row(row: SqlRow): MemoryRecord {
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

  _artifact_from_row(row: SqlRow): ArtifactMetadata {
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
    const conn = this.connect();
    let row: SqlRow | undefined;
    try {
      row = conn
        .prepare("select * from artifacts where artifact_id = ?")
        .get(artifactId) as SqlRow | undefined;
    } finally {
      conn.close();
    }
    if (row === undefined) {
      throw new KeyError(`Unknown artifact: ${artifactId}`);
    }
    return this._artifact_from_row(row);
  }

  insert_trace(trace: TraceRecord): void {
    const conn = this.connect();
    try {
      conn
        .prepare(
          `
          insert into traces(trace_id, run_id, trace_type, path, payload_hash, created_at)
          values (?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          trace.trace_id,
          trace.run_id,
          trace.trace_type,
          trace.path,
          trace.payload_hash,
          trace.created_at,
        );
    } finally {
      conn.close();
    }
  }

  get_trace(traceId: string): TraceRecord {
    const conn = this.connect();
    let row: SqlRow | undefined;
    try {
      row = conn.prepare("select * from traces where trace_id = ?").get(traceId) as
        | SqlRow
        | undefined;
    } finally {
      conn.close();
    }
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
    const conn = this.connect();
    let row: SqlRow | undefined;
    try {
      row = conn
        .prepare("select * from app_cache where cache_key = ?")
        .get(cacheKey) as SqlRow | undefined;
    } finally {
      conn.close();
    }
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
    const conn = this.connect();
    let rows: SqlRow[];
    try {
      rows = conn
        .prepare(
          `
          select cache_key, cache_type, provider, model, profile, prompt_version,
                 input_hash, created_at
          from app_cache
          order by created_at desc
          limit ?
          `,
        )
        .all(limit) as SqlRow[];
    } finally {
      conn.close();
    }
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
    const conn = this.connect();
    try {
      const result = conn.prepare("delete from app_cache").run();
      return result.changes;
    } finally {
      conn.close();
    }
  }

  upsert_app_cache_record(record: AppCacheRecord): void {
    const conn = this.connect();
    try {
      conn
        .prepare(
          `
          insert into app_cache(cache_key, cache_type, provider, model, profile,
                               prompt_version, input_hash, payload_json, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        )
        .run(
          record.cache_key,
          record.cache_type,
          record.provider,
          record.model,
          record.profile,
          record.prompt_version,
          record.input_hash,
          jsonDump(record.payload_json),
          record.created_at,
        );
    } finally {
      conn.close();
    }
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
}

class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}
