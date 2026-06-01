from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .schemas import (
    ArtifactMetadata,
    AppCacheRecord,
    ConversationSummary,
    ContextPacket,
    Diagnosis,
    ProviderResponse,
    ResearchIdeaPlanDraft,
    TraceRecord,
    ProviderRequest,
    new_id,
    utc_now,
)
from .workspace import ProjectWorkspace


def stable_json_hash(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class ContextBuilder:
    def build_for_idea(self, idea: str) -> ContextPacket:
        return ContextPacket(
            context_id=new_id("ctx"),
            mode="idea_plan",
            task="Diagnose a raw research idea into five top-conference-oriented fields.",
            idea=idea,
            relevant_artifacts=[],
            constraints=[
                "v0 uses the configured planner provider and records provider/tool traces.",
                "Do not claim novelty without literature retrieval.",
                "Produce diagnosis only; do not freeze a ResearchIdeaPlan.",
            ],
            source_refs=["user.idea"],
            excluded_context_summary="No prior artifacts or paper memory are retrieved in v0.",
            created_at=utc_now(),
        )


class MemoryManager:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.workspace = workspace

    def ensure_memory_entrypoint(self) -> Path:
        self.workspace.init()
        return self.workspace.workspace_dir / "memory" / "project-memory-map.md"

    def conversation_summary_dir(self) -> Path:
        self.workspace.init()
        path = self.workspace.workspace_dir / "memory" / "conversation-summaries"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def read_conversation_summary(self, thread_id: str) -> ConversationSummary | None:
        metadata_path = self.conversation_summary_dir() / f"{thread_id}.json"
        if not metadata_path.exists():
            return None
        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        return ConversationSummary.model_validate(payload)

    def write_conversation_summary(self, summary: ConversationSummary) -> ConversationSummary:
        summary_dir = self.conversation_summary_dir()
        markdown_path = summary_dir / f"{summary.thread_id}.md"
        metadata_path = summary_dir / f"{summary.thread_id}.json"
        markdown_path.write_text(
            "# Conversation Summary\n\n"
            f"- Thread: `{summary.thread_id}`\n"
            f"- Covered messages: `{summary.covered_message_count}`\n"
            f"- Covered until ordinal: `{summary.covered_until_ordinal}`\n"
            f"- Summary source: `{summary.summary_source}`\n"
            f"- Updated: `{summary.updated_at}`\n\n"
            "## Summary\n"
            f"{summary.summary_text}\n\n"
            "## Source Refs\n"
            + "\n".join(f"- `{ref}`" for ref in summary.source_refs)
            + "\n",
            encoding="utf-8",
        )
        normalized = summary.model_copy(
            update={
                "markdown_path": str(markdown_path),
                "metadata_path": str(metadata_path),
            }
        )
        metadata_path.write_text(
            json.dumps(normalized.model_dump(mode="json"), ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        return normalized


class CacheManager:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.workspace = workspace

    def _cache_key(self, request: ProviderRequest) -> str:
        return stable_json_hash(
            {
                "cache_type": "provider_response",
                "provider": request.provider,
                "model": request.model,
                "profile": request.profile,
                "prompt_version": request.prompt_version,
                "input_hash": request.input_hash,
            }
        )

    def get_provider_response(self, request: ProviderRequest) -> ProviderResponse | None:
        record = self.workspace.get_app_cache_record(self._cache_key(request))
        if record is None:
            return None
        return ProviderResponse.model_validate(record.payload_json)

    def store_provider_response(self, request: ProviderRequest, response: ProviderResponse) -> None:
        record = AppCacheRecord(
            cache_key=self._cache_key(request),
            cache_type="provider_response",
            provider=request.provider,
            model=request.model,
            profile=request.profile,
            prompt_version=request.prompt_version,
            input_hash=request.input_hash,
            payload_json=response.model_dump(mode="json"),
            created_at=utc_now(),
        )
        self.workspace.upsert_app_cache_record(record)


class TraceRecorder:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.workspace = workspace

    def record(self, run_id: str, trace_type: str, payload: dict[str, Any]) -> TraceRecord:
        self.workspace.ensure_initialized()
        trace_id = new_id("trace")
        path = self.workspace.workspace_dir / "traces" / f"{trace_id}.json"
        created_at = utc_now()
        serializable: dict[str, Any] = {
            "trace_id": trace_id,
            "run_id": run_id,
            "trace_type": trace_type,
            "payload": payload,
            "created_at": created_at,
        }
        path.write_text(
            json.dumps(serializable, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        trace = TraceRecord(
            trace_id=trace_id,
            run_id=run_id,
            trace_type=trace_type,
            path=str(path),
            payload_hash=stable_json_hash(serializable),
            created_at=created_at,
        )
        self.workspace.insert_trace(trace)
        return trace

    def read_payload(self, trace: TraceRecord) -> dict[str, Any]:
        payload = json.loads(Path(trace.path).read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}


class ArtifactManager:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.workspace = workspace

    def write_research_idea_draft(
        self,
        run_id: str,
        diagnosis: Diagnosis,
        context: ContextPacket,
        trace_refs: list[str],
        artifact_id: str | None = None,
    ) -> tuple[ArtifactMetadata, ResearchIdeaPlanDraft]:
        self.workspace.ensure_initialized()
        next_artifact_id = artifact_id or new_id("artifact")
        title = "ResearchIdeaPlanDraft"
        markdown_path = self.workspace.workspace_dir / "artifacts" / f"{next_artifact_id}.md"
        metadata_path = self.workspace.workspace_dir / "artifacts" / f"{next_artifact_id}.json"
        created_at = utc_now()

        markdown = self._render_markdown(diagnosis, context)
        markdown_path.write_text(markdown, encoding="utf-8")

        metadata = ArtifactMetadata(
            artifact_id=next_artifact_id,
            artifact_type="ResearchIdeaPlanDraft",
            status="draft",
            title=title,
            path=str(markdown_path),
            metadata_path=str(metadata_path),
            schema_version="v0",
            source_run_id=run_id,
            trace_refs=trace_refs,
            created_at=created_at,
        )
        draft = ResearchIdeaPlanDraft(
            artifact_id=next_artifact_id,
            title=title,
            source_run_id=run_id,
            diagnosis=diagnosis,
            context_id=context.context_id,
            markdown_path=str(markdown_path),
            metadata_path=str(metadata_path),
            created_at=created_at,
        )
        metadata_payload = {
            "metadata": metadata.model_dump(mode="json"),
            "draft": draft.model_dump(mode="json"),
        }
        metadata_path.write_text(
            json.dumps(metadata_payload, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        self.workspace.insert_artifact(metadata)
        return metadata, draft

    def read_artifact_content(self, artifact_id: str) -> tuple[ArtifactMetadata, str]:
        metadata = self.workspace.get_artifact_metadata(artifact_id)
        content = Path(metadata.path).read_text(encoding="utf-8")
        return metadata, content

    def read_research_idea_draft(
        self, artifact_id: str
    ) -> tuple[ArtifactMetadata, ResearchIdeaPlanDraft]:
        metadata = self.workspace.get_artifact_metadata(artifact_id)
        payload = json.loads(Path(metadata.metadata_path).read_text(encoding="utf-8"))
        return metadata, ResearchIdeaPlanDraft.model_validate(payload["draft"])

    def _render_markdown(self, diagnosis: Diagnosis, context: ContextPacket) -> str:
        evidence = "\n".join(f"- {item}" for item in diagnosis.evidence_needed)
        questions = "\n".join(f"- {item}" for item in diagnosis.clarifying_questions)
        if not questions:
            questions = "- None"
        return (
            "# ResearchIdeaPlanDraft\n\n"
            f"- Context: `{context.context_id}`\n"
            f"- Status: `draft`\n\n"
            "## Problem\n"
            f"{diagnosis.problem}\n\n"
            "## Gap\n"
            f"{diagnosis.gap}\n\n"
            "## Candidate Mechanism\n"
            f"{diagnosis.candidate_mechanism}\n\n"
            "## Evidence Needed\n"
            f"{evidence}\n\n"
            "## Main Uncertainty\n"
            f"{diagnosis.main_uncertainty}\n"
            "\n## Clarifying Questions\n"
            f"{questions}\n"
        )
