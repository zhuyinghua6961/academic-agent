from __future__ import annotations

import json
import os
import sqlite3
import hashlib
from pathlib import Path
from typing import Any, Literal, cast

from .config import render_default_project_config
from .schemas import (
    ArtifactMetadata,
    AppCacheRecord,
    AppCacheSummaryRecord,
    ModeRun,
    ProjectStatus,
    SSEEvent,
    ThreadMessage,
    ThreadSessionSummary,
    TraceRecord,
    WorkflowThread,
    new_id,
    utc_now,
)


REQUIRED_DIRS = ("artifacts", "traces", "memory", "cache")


def _project_id(project_root: Path) -> str:
    digest = hashlib.sha256(str(project_root.resolve()).encode("utf-8")).hexdigest()[:12]
    return f"project_{digest}"


def _json_dump(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def _json_load(payload: str | None) -> dict[str, Any]:
    if not payload:
        return {}
    loaded = json.loads(payload)
    return loaded if isinstance(loaded, dict) else {}


def _default_thread_title(thread_id: str) -> str:
    return f"Untitled {thread_id[-6:]}"


class ProjectWorkspace:
    def __init__(self, project_root: Path | str | None = None) -> None:
        env_root = os.environ.get("ACADEMIC_AGENT_PROJECT_ROOT")
        root = Path(project_root or env_root or Path.cwd())
        self.project_root = root.resolve()
        self.workspace_dir = self.project_root / ".academic-agent"
        self.db_path = self.workspace_dir / "academic-agent.sqlite3"
        self.project_id = _project_id(self.project_root)

    @property
    def directories(self) -> list[Path]:
        return [self.workspace_dir / name for name in REQUIRED_DIRS]

    def init(self) -> ProjectStatus:
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        for directory in self.directories:
            directory.mkdir(parents=True, exist_ok=True)

        memory_map = self.workspace_dir / "memory" / "project-memory-map.md"
        if not memory_map.exists():
            memory_map.write_text(
                "# Project Memory Map\n\n"
                "v0 scaffold: memory retrieval is not implemented yet. "
                "This file is the future navigation entry point for project memory.\n",
                encoding="utf-8",
            )

        config_path = self.workspace_dir / "config.toml"
        if not config_path.exists():
            config_path.write_text(render_default_project_config(), encoding="utf-8")

        with self.connect() as conn:
            self._init_db(conn)
            self._migrate_db(conn)
            conn.execute(
                """
                insert or ignore into projects(project_id, project_root, workspace_dir, created_at)
                values (?, ?, ?, ?)
                """,
                (self.project_id, str(self.project_root), str(self.workspace_dir), utc_now()),
            )
            conn.commit()

        return self.status()

    def status(self) -> ProjectStatus:
        initialized = self.db_path.exists() and all(path.exists() for path in self.directories)
        return ProjectStatus(
            project_id=self.project_id,
            project_root=str(self.project_root),
            workspace_dir=str(self.workspace_dir),
            db_path=str(self.db_path),
            initialized=initialized,
            directories=[str(path) for path in self.directories],
        )

    def connect(self) -> sqlite3.Connection:
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self, conn: sqlite3.Connection) -> None:
        conn.executescript(
            """
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
            """
        )

    def _migrate_db(self, conn: sqlite3.Connection) -> None:
        columns = {
            row["name"]
            for row in conn.execute("pragma table_info(threads)").fetchall()
        }
        if "name" not in columns:
            conn.execute("alter table threads add column name text")
        conn.execute(
            """
            create unique index if not exists threads_project_name_unique
            on threads(project_id, name)
            """
        )

        messages_columns = {
            row["name"]
            for row in conn.execute("pragma table_info(messages)").fetchall()
        }
        for col in ("tool_call_id", "tool_name", "tool_args_json", "parent_message_id"):
            if col not in messages_columns:
                conn.execute(f"alter table messages add column {col} text")

    def ensure_initialized(self) -> None:
        if not self.status().initialized:
            self.init()

    def _thread_from_row(self, row: sqlite3.Row) -> WorkflowThread:
        return WorkflowThread(
            thread_id=row["thread_id"],
            project_id=row["project_id"],
            name=row["name"],
            created_at=row["created_at"],
        )

    def get_thread(self, thread_id: str) -> WorkflowThread:
        self.ensure_initialized()
        with self.connect() as conn:
            row = conn.execute(
                "select thread_id, project_id, name, created_at from threads where thread_id = ?",
                (thread_id,),
            ).fetchone()
        if row is None:
            raise KeyError(f"Unknown thread: {thread_id}")
        return self._thread_from_row(row)

    def list_threads(self, limit: int = 50, include_empty: bool = True) -> list[WorkflowThread]:
        self.ensure_initialized()
        message_filter = "" if include_empty else "where exists (select 1 from messages where messages.thread_id = threads.thread_id)"
        with self.connect() as conn:
            rows = conn.execute(
                f"""
                select thread_id, project_id, name, created_at
                from threads
                {message_filter}
                order by created_at desc
                limit ?
                """,
                (limit,),
            ).fetchall()
        return [self._thread_from_row(row) for row in rows]

    def list_thread_sessions(self, limit: int = 50) -> list[ThreadSessionSummary]:
        self.ensure_initialized()
        with self.connect() as conn:
            rows = conn.execute(
                """
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
                    ) as last_run_at
                from threads
                join messages on messages.thread_id = threads.thread_id and messages.role != 'tool'
                group by threads.thread_id
                order by coalesce(last_message_at, last_run_at, threads.created_at) desc
                limit ?
                """,
                (limit,),
            ).fetchall()
        return [
            ThreadSessionSummary(
                thread_id=row["thread_id"],
                project_id=row["project_id"],
                name=row["name"],
                title=row["name"] or _default_thread_title(row["thread_id"]),
                created_at=row["created_at"],
                updated_at=row["last_message_at"] or row["last_run_at"] or row["created_at"],
                message_count=int(row["message_count"]),
                latest_run_id=row["latest_run_id"],
                latest_status=row["latest_status"],
            )
            for row in rows
        ]

    def find_thread_by_name(self, name: str) -> WorkflowThread:
        self.ensure_initialized()
        normalized = name.strip()
        if not normalized:
            raise ValueError("Thread name cannot be empty")
        with self.connect() as conn:
            row = conn.execute(
                """
                select thread_id, project_id, name, created_at
                from threads
                where project_id = ? and name = ?
                """,
                (self.project_id, normalized),
            ).fetchone()
        if row is None:
            raise KeyError(f"Unknown thread name: {normalized}")
        return self._thread_from_row(row)

    def rename_thread(self, thread_id: str, name: str) -> WorkflowThread:
        self.ensure_initialized()
        normalized = name.strip()
        if not normalized:
            raise ValueError("Thread name cannot be empty")
        with self.connect() as conn:
            current = conn.execute(
                "select thread_id from threads where thread_id = ?",
                (thread_id,),
            ).fetchone()
            if current is None:
                raise KeyError(f"Unknown thread: {thread_id}")
            conflict = conn.execute(
                """
                select thread_id
                from threads
                where project_id = ? and name = ? and thread_id != ?
                """,
                (self.project_id, normalized, thread_id),
            ).fetchone()
            if conflict is not None:
                raise ValueError(f"Thread name already exists: {normalized}")
            conn.execute(
                """
                update threads
                set name = ?
                where thread_id = ?
                """,
                (normalized, thread_id),
            )
            conn.commit()
        return self.get_thread(thread_id)

    def create_thread(self, thread_id: str | None = None, name: str | None = None) -> WorkflowThread:
        self.ensure_initialized()
        now = utc_now()
        next_thread_id = thread_id or new_id("thread")
        existing = None
        if thread_id is not None:
            with self.connect() as conn:
                existing = conn.execute(
                    "select thread_id, project_id, name, created_at from threads where thread_id = ?",
                    (thread_id,),
                ).fetchone()
        if existing is not None:
            return self._thread_from_row(existing)
        thread = WorkflowThread(
            thread_id=next_thread_id,
            project_id=self.project_id,
            name=name.strip() if name and name.strip() else None,
            created_at=now,
        )
        with self.connect() as conn:
            conn.execute(
                """
                insert or ignore into threads(thread_id, project_id, name, created_at)
                values (?, ?, ?, ?)
                """,
                (thread.thread_id, thread.project_id, thread.name, thread.created_at),
            )
            conn.commit()
        return thread

    def add_message(
        self,
        thread_id: str,
        role: str,
        content: str,
        run_id: str | None = None,
        tool_call_id: str | None = None,
        tool_name: str | None = None,
        tool_args: dict[str, Any] | None = None,
        parent_message_id: str | None = None,
    ) -> ThreadMessage:
        self.ensure_initialized()
        if role not in {"user", "assistant", "tool"}:
            raise ValueError(f"Unsupported message role: {role}")
        message_role = cast(Literal["user", "assistant", "tool"], role)
        tool_args_json = _json_dump(tool_args) if tool_args else None
        with self.connect() as conn:
            ordinal_row = conn.execute(
                "select coalesce(max(ordinal), 0) + 1 as next_ordinal from messages where thread_id = ?",
                (thread_id,),
            ).fetchone()
            message = ThreadMessage(
                message_id=new_id("msg"),
                thread_id=thread_id,
                role=message_role,
                content=content,
                run_id=run_id,
                created_at=utc_now(),
                ordinal=int(ordinal_row["next_ordinal"]),
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                tool_args=tool_args,
                parent_message_id=parent_message_id,
            )
            conn.execute(
                """
                insert into messages(message_id, thread_id, role, content, run_id,
                                     created_at, ordinal, tool_call_id, tool_name,
                                     tool_args_json, parent_message_id)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    message.message_id,
                    message.thread_id,
                    message.role,
                    message.content,
                    message.run_id,
                    message.created_at,
                    message.ordinal,
                    message.tool_call_id,
                    message.tool_name,
                    tool_args_json,
                    message.parent_message_id,
                ),
            )
            conn.commit()
        return message

    def list_messages(self, thread_id: str) -> list[ThreadMessage]:
        self.ensure_initialized()
        with self.connect() as conn:
            rows = conn.execute(
                "select * from messages where thread_id = ? order by ordinal asc",
                (thread_id,),
            ).fetchall()
        return [
            ThreadMessage(
                message_id=row["message_id"],
                thread_id=row["thread_id"],
                role=row["role"],
                content=row["content"],
                run_id=row["run_id"],
                created_at=row["created_at"],
                ordinal=row["ordinal"],
                tool_call_id=row["tool_call_id"],
                tool_name=row["tool_name"],
                tool_args=_json_load(row["tool_args_json"]) or None,
                parent_message_id=row["parent_message_id"],
            )
            for row in rows
        ]

    def create_run(self, thread_id: str, idea: str) -> ModeRun:
        self.ensure_initialized()
        now = utc_now()
        run = ModeRun(
            run_id=new_id("run"),
            thread_id=thread_id,
            mode="idea_plan",
            status="created",
            input_idea=idea,
            created_at=now,
            updated_at=now,
        )
        with self.connect() as conn:
            conn.execute(
                """
                insert into runs(run_id, thread_id, mode, status, input_idea, artifact_id, error,
                                 created_at, updated_at)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run.run_id,
                    run.thread_id,
                    run.mode,
                    run.status,
                    run.input_idea,
                    run.artifact_id,
                    run.error,
                    run.created_at,
                    run.updated_at,
                ),
            )
            conn.commit()
        return run

    def update_run(
        self,
        run_id: str,
        status: str,
        artifact_id: str | None = None,
        error: str | None = None,
    ) -> ModeRun:
        now = utc_now()
        with self.connect() as conn:
            existing = conn.execute("select artifact_id from runs where run_id = ?", (run_id,)).fetchone()
            if existing is None:
                raise KeyError(f"Unknown run: {run_id}")
            next_artifact_id = artifact_id if artifact_id is not None else existing["artifact_id"]
            conn.execute(
                """
                update runs
                set status = ?, artifact_id = ?, error = ?, updated_at = ?
                where run_id = ?
                """,
                (status, next_artifact_id, error, now, run_id),
            )
            conn.commit()
        return self.get_run(run_id)

    def get_run(self, run_id: str) -> ModeRun:
        with self.connect() as conn:
            row = conn.execute("select * from runs where run_id = ?", (run_id,)).fetchone()
        if row is None:
            raise KeyError(f"Unknown run: {run_id}")
        return ModeRun(
            run_id=row["run_id"],
            thread_id=row["thread_id"],
            mode=row["mode"],
            status=row["status"],
            input_idea=row["input_idea"],
            artifact_id=row["artifact_id"],
            error=row["error"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def list_runs(self, limit: int = 50) -> list[ModeRun]:
        self.ensure_initialized()
        with self.connect() as conn:
            rows = conn.execute(
                """
                select * from runs
                order by created_at desc
                limit ?
                """,
                (limit,),
            ).fetchall()
        return [
            ModeRun(
                run_id=row["run_id"],
                thread_id=row["thread_id"],
                mode=row["mode"],
                status=row["status"],
                input_idea=row["input_idea"],
                artifact_id=row["artifact_id"],
                error=row["error"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )
            for row in rows
        ]

    def add_event(self, run_id: str, event_type: str, payload: dict[str, Any] | None = None) -> SSEEvent:
        self.ensure_initialized()
        with self.connect() as conn:
            ordinal_row = conn.execute(
                "select coalesce(max(ordinal), 0) + 1 as next_ordinal from events where run_id = ?",
                (run_id,),
            ).fetchone()
            event = SSEEvent(
                event_id=new_id("evt"),
                run_id=run_id,
                event_type=event_type,
                payload=payload or {},
                created_at=utc_now(),
                ordinal=int(ordinal_row["next_ordinal"]),
            )
            conn.execute(
                """
                insert into events(event_id, run_id, event_type, payload_json, created_at, ordinal)
                values (?, ?, ?, ?, ?, ?)
                """,
                (
                    event.event_id,
                    event.run_id,
                    event.event_type,
                    _json_dump(event.payload),
                    event.created_at,
                    event.ordinal,
                ),
            )
            conn.commit()
        return event

    def list_events(self, run_id: str) -> list[SSEEvent]:
        with self.connect() as conn:
            rows = conn.execute(
                "select * from events where run_id = ? order by ordinal asc",
                (run_id,),
            ).fetchall()
        return [
            SSEEvent(
                event_id=row["event_id"],
                run_id=row["run_id"],
                event_type=row["event_type"],
                payload=_json_load(row["payload_json"]),
                created_at=row["created_at"],
                ordinal=row["ordinal"],
            )
            for row in rows
        ]

    def list_events_after(self, run_id: str, ordinal: int) -> list[SSEEvent]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                select * from events
                where run_id = ? and ordinal > ?
                order by ordinal asc
                """,
                (run_id, ordinal),
            ).fetchall()
        return [
            SSEEvent(
                event_id=row["event_id"],
                run_id=row["run_id"],
                event_type=row["event_type"],
                payload=_json_load(row["payload_json"]),
                created_at=row["created_at"],
                ordinal=row["ordinal"],
            )
            for row in rows
        ]

    def insert_artifact(self, metadata: ArtifactMetadata) -> None:
        with self.connect() as conn:
            conn.execute(
                """
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
                """,
                (
                    metadata.artifact_id,
                    metadata.source_run_id,
                    metadata.artifact_type,
                    metadata.status,
                    metadata.title,
                    metadata.path,
                    metadata.metadata_path,
                    metadata.schema_version,
                    _json_dump({"trace_refs": metadata.trace_refs}),
                    metadata.created_at,
                ),
            )
            conn.commit()

    def latest_artifact_for_thread(
        self,
        thread_id: str,
        artifact_type: str = "ResearchIdeaPlanDraft",
    ) -> ArtifactMetadata | None:
        self.ensure_initialized()
        with self.connect() as conn:
            row = conn.execute(
                """
                select artifacts.*
                from artifacts
                join runs on runs.run_id = artifacts.run_id
                where runs.thread_id = ? and artifacts.artifact_type = ?
                order by artifacts.created_at desc
                limit 1
                """,
                (thread_id, artifact_type),
            ).fetchone()
        if row is None:
            return None
        return ArtifactMetadata(
            artifact_id=row["artifact_id"],
            artifact_type=row["artifact_type"],
            status=row["status"],
            title=row["title"],
            path=row["path"],
            metadata_path=row["metadata_path"],
            schema_version=row["schema_version"],
            source_run_id=row["run_id"],
            trace_refs=_json_load(row["trace_refs_json"]).get("trace_refs", []),
            created_at=row["created_at"],
        )

    def get_artifact_metadata(self, artifact_id: str) -> ArtifactMetadata:
        with self.connect() as conn:
            row = conn.execute(
                "select * from artifacts where artifact_id = ?",
                (artifact_id,),
            ).fetchone()
        if row is None:
            raise KeyError(f"Unknown artifact: {artifact_id}")
        return ArtifactMetadata(
            artifact_id=row["artifact_id"],
            artifact_type=row["artifact_type"],
            status=row["status"],
            title=row["title"],
            path=row["path"],
            metadata_path=row["metadata_path"],
            schema_version=row["schema_version"],
            source_run_id=row["run_id"],
            trace_refs=_json_load(row["trace_refs_json"]).get("trace_refs", []),
            created_at=row["created_at"],
        )

    def insert_trace(self, trace: TraceRecord) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                insert into traces(trace_id, run_id, trace_type, path, payload_hash, created_at)
                values (?, ?, ?, ?, ?, ?)
                """,
                (
                    trace.trace_id,
                    trace.run_id,
                    trace.trace_type,
                    trace.path,
                    trace.payload_hash,
                    trace.created_at,
                ),
            )
            conn.commit()

    def get_trace(self, trace_id: str) -> TraceRecord:
        with self.connect() as conn:
            row = conn.execute("select * from traces where trace_id = ?", (trace_id,)).fetchone()
        if row is None:
            raise KeyError(f"Unknown trace: {trace_id}")
        return TraceRecord(
            trace_id=row["trace_id"],
            run_id=row["run_id"],
            trace_type=row["trace_type"],
            path=row["path"],
            payload_hash=row["payload_hash"],
            created_at=row["created_at"],
        )

    def get_app_cache_record(self, cache_key: str) -> AppCacheRecord | None:
        with self.connect() as conn:
            row = conn.execute("select * from app_cache where cache_key = ?", (cache_key,)).fetchone()
        if row is None:
            return None
        return AppCacheRecord(
            cache_key=row["cache_key"],
            cache_type=row["cache_type"],
            provider=row["provider"],
            model=row["model"],
            profile=row["profile"],
            prompt_version=row["prompt_version"],
            input_hash=row["input_hash"],
            payload_json=_json_load(row["payload_json"]),
            created_at=row["created_at"],
        )

    def list_app_cache_records(self, limit: int = 50) -> list[AppCacheSummaryRecord]:
        self.ensure_initialized()
        with self.connect() as conn:
            rows = conn.execute(
                """
                select cache_key, cache_type, provider, model, profile, prompt_version,
                       input_hash, created_at
                from app_cache
                order by created_at desc
                limit ?
                """,
                (limit,),
            ).fetchall()
        return [
            AppCacheSummaryRecord(
                cache_key=row["cache_key"],
                cache_type=row["cache_type"],
                provider=row["provider"],
                model=row["model"],
                profile=row["profile"],
                prompt_version=row["prompt_version"],
                input_hash=row["input_hash"],
                created_at=row["created_at"],
            )
            for row in rows
        ]

    def clear_app_cache_records(self) -> int:
        self.ensure_initialized()
        with self.connect() as conn:
            cursor = conn.execute("delete from app_cache")
            conn.commit()
            return cursor.rowcount

    def upsert_app_cache_record(self, record: AppCacheRecord) -> None:
        with self.connect() as conn:
            conn.execute(
                """
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
                """,
                (
                    record.cache_key,
                    record.cache_type,
                    record.provider,
                    record.model,
                    record.profile,
                    record.prompt_version,
                    record.input_hash,
                    _json_dump(record.payload_json),
                    record.created_at,
                ),
            )
            conn.commit()
