from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path
from typing import AsyncIterator, cast

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse

from .config import AgentConfig
from .graph import IdeaPlanRunner, build_context_usage
from .harness import ArtifactManager, MemoryManager
from .search import create_default_search_engine
from .schemas import (
    AppCacheClearResponse,
    AppCacheListResponse,
    ArtifactReadResponse,
    ContinueIdeaPlanThreadRequest,
    ConflictListResponse,
    ContextUsageResponse,
    CoreCapabilitiesResponse,
    CreateIdeaPlanRunRequest,
    CurrentIdeaPlanResponse,
    FreezeIdeaPlanResponse,
    MemoryMapResponse,
    MemoryRecheckResponse,
    MemorySearchResponse,
    RunListResponse,
    RunResultResponse,
    ModeRun,
    PaperSearchRequest,
    ProviderProfilesResponse,
    ProjectInitRequest,
    ProjectStatus,
    RenameThreadRequest,
    ReviewIdeaPlanRequest,
    ReviewIdeaPlanResponse,
    SearchProviderStatus,
    SearchProvidersResponse,
    StartIdeaPlanRunResponse,
    ThreadListResponse,
    ThreadMessagesResponse,
    WorkflowThread,
    TraceReadResponse,
    SearchResponse,
)
from .workspace import ProjectWorkspace


TERMINAL_RUN_STATUSES = {"completed", "failed", "cancelled"}
CORE_VERSION = "0.1.1"
CORE_CAPABILITIES = [
    "run_cancel",
    "thread_session_summary",
    "session_artifact_update",
    "react_agent_loop",
    "paper_search_tool",
    "context_usage",
    "idea_plan_current_artifact",
    "idea_plan_freeze",
    "idea_plan_review_gate",
    "provider_streaming",
    "project_memory_map",
    "memory_records",
    "memory_hybrid_search",
    "memory_conflict_records",
    "memory_stale_recheck",
]


def create_app(project_root: Path | str | None = None) -> FastAPI:
    app = FastAPI(title="Academic Agent Core", version="0.1.0")
    app.state.workspace = ProjectWorkspace(project_root)
    app.state.tasks = {}

    def workspace() -> ProjectWorkspace:
        return cast(ProjectWorkspace, app.state.workspace)

    @app.get("/capabilities", response_model=CoreCapabilitiesResponse)
    async def capabilities() -> CoreCapabilitiesResponse:
        return CoreCapabilitiesResponse(
            version=CORE_VERSION,
            capabilities=CORE_CAPABILITIES,
        )

    @app.post("/projects/init", response_model=ProjectStatus)
    async def init_project(payload: ProjectInitRequest | None = Body(default=None)) -> ProjectStatus:
        if payload and payload.project_root:
            app.state.workspace = ProjectWorkspace(payload.project_root)
        return workspace().init()

    @app.get("/projects/status", response_model=ProjectStatus)
    async def project_status() -> ProjectStatus:
        return workspace().status()

    @app.get("/providers/profiles", response_model=ProviderProfilesResponse)
    async def provider_profiles() -> ProviderProfilesResponse:
        config = AgentConfig.load(workspace().project_root)
        return ProviderProfilesResponse(
            profiles=config.statuses(),
            config_sources=config.sources,
        )

    @app.get("/context-usage", response_model=ContextUsageResponse)
    async def project_context_usage(draft: str = "") -> ContextUsageResponse:
        workspace().init()
        return build_context_usage(workspace(), draft_input=draft)

    @app.get("/memory/map", response_model=MemoryMapResponse)
    async def read_memory_map() -> MemoryMapResponse:
        manager = MemoryManager(workspace())
        memory_map = manager.read_project_memory_map()
        return MemoryMapResponse(
            memory_map=memory_map,
            content=manager.read_project_memory_markdown(),
        )

    @app.post("/memory/rebuild", response_model=MemoryMapResponse)
    async def rebuild_memory_map() -> MemoryMapResponse:
        manager = MemoryManager(workspace())
        memory_map = manager.rebuild_project_memory_map()
        return MemoryMapResponse(
            memory_map=memory_map,
            content=manager.read_project_memory_markdown(),
        )

    @app.get("/memory/search", response_model=MemorySearchResponse)
    async def search_memory(
        q: str,
        thread_id: str | None = None,
        limit: int = 8,
    ) -> MemorySearchResponse:
        return MemoryManager(workspace()).search_memory(q, thread_id=thread_id, limit=limit)

    @app.get("/memory/conflicts", response_model=ConflictListResponse)
    async def list_memory_conflicts(
        thread_id: str | None = None,
        status: str | None = "open",
        limit: int = 100,
    ) -> ConflictListResponse:
        return ConflictListResponse(
            conflicts=workspace().list_conflict_records(
                thread_id=thread_id,
                status=status,
                limit=limit,
            )
        )

    @app.post("/memory/recheck", response_model=MemoryRecheckResponse)
    async def recheck_memory() -> MemoryRecheckResponse:
        manager = MemoryManager(workspace())
        stale_count = manager.recheck_stale_records()
        conflicts = manager.detect_conflicts()
        memory_map = manager.rebuild_project_memory_map()
        return MemoryRecheckResponse(
            stale_count=stale_count,
            conflict_count=len(conflicts),
            memory_map=memory_map,
        )

    @app.get("/cache", response_model=AppCacheListResponse)
    async def list_cache(limit: int = 50) -> AppCacheListResponse:
        return AppCacheListResponse(records=workspace().list_app_cache_records(limit=limit))

    @app.delete("/cache", response_model=AppCacheClearResponse)
    async def clear_cache() -> AppCacheClearResponse:
        return AppCacheClearResponse(deleted=workspace().clear_app_cache_records())

    @app.post("/search/papers", response_model=SearchResponse)
    async def paper_search(payload: PaperSearchRequest) -> SearchResponse:
        config = AgentConfig.load(workspace().project_root)
        return create_default_search_engine(config.search, config.env).paper_search(
            query=payload.query,
            max_results=payload.max_results,
            sources=payload.sources,
            sort_by=payload.sort_by,
        )

    @app.get("/search/providers", response_model=SearchProvidersResponse)
    async def search_providers() -> SearchProvidersResponse:
        config = AgentConfig.load(workspace().project_root)
        providers = []
        for source, provider in config.search.providers.items():
            has_api_key = bool(provider.api_key_env and config.env.get(provider.api_key_env))
            providers.append(
                SearchProviderStatus(
                    source=source,
                    enabled=provider.enabled,
                    configured=provider.api_key_env is None or has_api_key,
                    api_key_env=provider.api_key_env,
                    has_api_key=has_api_key,
                    base_url=provider.base_url,
                )
            )
        return SearchProvidersResponse(
            paper_sources=config.search.paper_sources,
            web_sources=config.search.web_sources,
            providers=providers,
        )

    @app.post("/runs/idea-plan", response_model=StartIdeaPlanRunResponse)
    async def create_idea_plan_run(payload: CreateIdeaPlanRunRequest) -> StartIdeaPlanRunResponse:
        return _start_idea_plan_background_run(
            workspace=workspace(),
            tasks=app.state.tasks,
            idea=payload.idea,
            thread_id=payload.thread_id,
        )

    @app.post("/threads/{thread_id}/idea-plan", response_model=StartIdeaPlanRunResponse)
    async def continue_idea_plan_thread(
        thread_id: str,
        payload: ContinueIdeaPlanThreadRequest,
    ) -> StartIdeaPlanRunResponse:
        if not workspace().list_messages(thread_id):
            raise HTTPException(status_code=404, detail=f"Unknown thread: {thread_id}")
        return _start_idea_plan_background_run(
            workspace=workspace(),
            tasks=app.state.tasks,
            idea=payload.content,
            thread_id=thread_id,
        )

    @app.get("/threads", response_model=ThreadListResponse)
    async def list_threads(limit: int = 50) -> ThreadListResponse:
        return ThreadListResponse(threads=workspace().list_thread_sessions(limit=limit))

    @app.get("/threads/{thread_id}", response_model=WorkflowThread)
    async def read_thread(thread_id: str) -> WorkflowThread:
        try:
            return workspace().get_thread(thread_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/threads/by-name/{name}", response_model=WorkflowThread)
    async def read_thread_by_name(name: str) -> WorkflowThread:
        try:
            return workspace().find_thread_by_name(name)
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/threads/{thread_id}/rename", response_model=WorkflowThread)
    async def rename_thread(thread_id: str, payload: RenameThreadRequest) -> WorkflowThread:
        try:
            return workspace().rename_thread(thread_id, payload.name)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/threads/{thread_id}/rename-auto", response_model=WorkflowThread)
    async def auto_rename_thread(thread_id: str) -> WorkflowThread:
        try:
            IdeaPlanRunner(workspace()).auto_rename_thread(thread_id)
            return workspace().get_thread(thread_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/threads/{thread_id}/messages", response_model=ThreadMessagesResponse)
    async def read_thread_messages(thread_id: str) -> ThreadMessagesResponse:
        try:
            thread = workspace().get_thread(thread_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        messages = workspace().list_messages(thread_id)
        if not messages:
            raise HTTPException(status_code=404, detail=f"Unknown thread: {thread_id}")
        return ThreadMessagesResponse(thread=thread, messages=messages)

    @app.get("/threads/{thread_id}/plan", response_model=CurrentIdeaPlanResponse)
    async def read_thread_plan(thread_id: str) -> CurrentIdeaPlanResponse:
        try:
            thread = workspace().get_thread(thread_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        artifact = workspace().latest_plan_artifact_for_thread(thread_id)
        if artifact is None:
            return CurrentIdeaPlanResponse(
                thread=thread,
                artifact=None,
                draft=None,
                session_status="needs literature",
            )
        manager = ArtifactManager(workspace())
        if artifact.artifact_type == "ResearchIdeaPlan":
            _, plan = manager.read_research_idea_plan(artifact.artifact_id)
            return CurrentIdeaPlanResponse(
                thread=thread,
                artifact=artifact,
                draft=plan,
                session_status=workspace().thread_session_status(thread_id),
                latest_run_id=artifact.source_run_id,
                latest_status=workspace().get_run(artifact.source_run_id).status,
            )
        _, draft = manager.read_research_idea_draft(artifact.artifact_id)
        return CurrentIdeaPlanResponse(
            thread=thread,
            artifact=artifact,
            draft=draft,
            session_status=workspace().thread_session_status(thread_id),
            latest_run_id=artifact.source_run_id,
            latest_status=workspace().get_run(artifact.source_run_id).status,
        )

    @app.post("/threads/{thread_id}/freeze", response_model=FreezeIdeaPlanResponse)
    async def freeze_thread_plan(thread_id: str) -> FreezeIdeaPlanResponse:
        try:
            thread = workspace().get_thread(thread_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        artifact = workspace().latest_plan_artifact_for_thread(thread_id)
        if artifact is None:
            raise HTTPException(status_code=404, detail=f"No idea plan draft for thread: {thread_id}")
        manager = ArtifactManager(workspace())
        if artifact.artifact_type == "ResearchIdeaPlan":
            _, plan = manager.read_research_idea_plan(artifact.artifact_id)
            return FreezeIdeaPlanResponse(thread=thread, artifact=artifact, plan=plan)
        source_metadata, draft = manager.read_research_idea_draft(artifact.artifact_id)
        frozen_artifact, plan = manager.freeze_research_idea_plan(source_metadata, draft)
        workspace().add_event(
            draft.source_run_id,
            "plan.frozen",
            {
                "artifact_id": frozen_artifact.artifact_id,
                "source_draft_artifact_id": source_metadata.artifact_id,
                "thread_id": thread_id,
            },
        )
        memory_map = MemoryManager(workspace()).rebuild_project_memory_map()
        workspace().add_event(
            draft.source_run_id,
            "memory.map.updated",
            {
                "path": memory_map.markdown_path,
                "metadata_path": memory_map.metadata_path,
                "record_count": memory_map.record_count,
                "thread_count": memory_map.thread_count,
            },
        )
        return FreezeIdeaPlanResponse(thread=thread, artifact=frozen_artifact, plan=plan)

    @app.post("/threads/{thread_id}/review", response_model=ReviewIdeaPlanResponse)
    async def review_thread_plan(
        thread_id: str,
        payload: ReviewIdeaPlanRequest,
    ) -> ReviewIdeaPlanResponse:
        try:
            thread = workspace().get_thread(thread_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        artifact = workspace().latest_plan_artifact_for_thread(thread_id)
        if artifact is None:
            raise HTTPException(status_code=404, detail=f"No idea plan draft for thread: {thread_id}")
        workspace().record_idea_review(
            thread_id=thread_id,
            artifact_id=artifact.artifact_id,
            run_id=artifact.source_run_id,
            decision=payload.decision,
            notes=payload.notes,
        )
        workspace().add_event(
            artifact.source_run_id,
            "idea.review.recorded",
            {
                "thread_id": thread_id,
                "artifact_id": artifact.artifact_id,
                "decision": payload.decision,
                "notes": payload.notes,
            },
        )
        memory_map = MemoryManager(workspace()).rebuild_project_memory_map()
        workspace().add_event(
            artifact.source_run_id,
            "memory.map.updated",
            {
                "path": memory_map.markdown_path,
                "metadata_path": memory_map.metadata_path,
                "record_count": memory_map.record_count,
                "thread_count": memory_map.thread_count,
            },
        )
        return ReviewIdeaPlanResponse(
            thread=thread,
            decision=payload.decision,
            session_status=workspace().thread_session_status(thread_id),
            notes=payload.notes,
        )

    @app.get("/threads/{thread_id}/context-usage", response_model=ContextUsageResponse)
    async def thread_context_usage(thread_id: str, draft: str = "") -> ContextUsageResponse:
        try:
            workspace().get_thread(thread_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return build_context_usage(workspace(), thread_id=thread_id, draft_input=draft)

    @app.get("/runs", response_model=RunListResponse)
    async def list_runs(limit: int = 50) -> RunListResponse:
        return RunListResponse(runs=workspace().list_runs(limit=limit))

    @app.get("/runs/{run_id}", response_model=ModeRun)
    async def read_run(run_id: str) -> ModeRun:
        try:
            return workspace().get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/runs/{run_id}/cancel", response_model=ModeRun)
    async def cancel_run(run_id: str) -> ModeRun:
        try:
            run = workspace().get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if run.status in TERMINAL_RUN_STATUSES:
            return run
        cancelled = workspace().update_run(run_id, "cancelled", error="Run cancelled by user")
        workspace().add_event(run_id, "run.cancelled", {"reason": "Run cancelled by user"})
        return cancelled

    @app.get("/runs/{run_id}/events")
    async def run_events(run_id: str, request: Request) -> StreamingResponse:
        try:
            workspace().get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        async def generate() -> AsyncIterator[str]:
            last_ordinal = 0
            while True:
                events = workspace().list_events_after(run_id, last_ordinal)
                for event in events:
                    last_ordinal = event.ordinal
                    yield (
                        f"id: {event.event_id}\n"
                        f"event: {event.event_type}\n"
                        f"data: {event.model_dump_json()}\n\n"
                    )

                if await request.is_disconnected():
                    break

                run = workspace().get_run(run_id)
                if run.status in TERMINAL_RUN_STATUSES and not events:
                    break

                await asyncio.sleep(0.05)

        return StreamingResponse(generate(), media_type="text/event-stream")

    @app.get("/runs/{run_id}/result", response_model=RunResultResponse)
    async def read_run_result(run_id: str) -> RunResultResponse:
        try:
            run = workspace().get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if run.status != "completed" or run.artifact_id is None:
            raise HTTPException(status_code=409, detail=f"Run {run_id} is not completed")
        try:
            artifact, draft = ArtifactManager(workspace()).read_research_idea_draft(run.artifact_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return RunResultResponse(
            run=run,
            artifact=artifact,
            draft=draft,
            thread=workspace().get_thread(run.thread_id),
            messages=workspace().list_messages(run.thread_id),
        )

    @app.get("/artifacts/{artifact_id}", response_model=ArtifactReadResponse)
    async def read_artifact(artifact_id: str) -> ArtifactReadResponse:
        try:
            metadata, content = ArtifactManager(workspace()).read_artifact_content(artifact_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return ArtifactReadResponse(metadata=metadata, content=content)

    @app.get("/traces/{trace_id}", response_model=TraceReadResponse)
    async def read_trace(trace_id: str) -> TraceReadResponse:
        try:
            trace = workspace().get_trace(trace_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        payload = json.loads(Path(trace.path).read_text(encoding="utf-8"))
        return TraceReadResponse(trace=trace, payload=payload)

    return app


app = create_app()


def _start_idea_plan_background_run(
    workspace: ProjectWorkspace,
    tasks: dict[str, threading.Thread],
    idea: str,
    thread_id: str | None = None,
) -> StartIdeaPlanRunResponse:
    runner = IdeaPlanRunner(workspace)
    run = runner.create_run(idea, thread_id)
    thread = threading.Thread(
        target=_execute_run_safely,
        args=(workspace, run.run_id),
        daemon=True,
    )
    tasks[run.run_id] = thread
    thread.start()
    return StartIdeaPlanRunResponse(
        run=run,
        run_url=f"/runs/{run.run_id}",
        events_url=f"/runs/{run.run_id}/events",
    )


def _execute_run_safely(workspace: ProjectWorkspace, run_id: str) -> None:
    try:
        IdeaPlanRunner(workspace).execute_run(run_id)
    except Exception:
        # execute_run records run.failed for graph/provider failures. This guard prevents
        # background worker exceptions from taking down the API process in v0.1.
        pass
