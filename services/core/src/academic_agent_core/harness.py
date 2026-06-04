from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import AgentConfig, MemoryConfig
from .schemas import (
    ArtifactMetadata,
    AppCacheRecord,
    ConversationSummary,
    ContextPacket,
    ConflictRecord,
    Diagnosis,
    MemoryRecord,
    MemorySearchResponse,
    MemorySearchResult,
    PaperSearchEvidence,
    ProjectMemoryMap,
    ProviderResponse,
    ResearchIdeaPlan,
    ResearchIdeaPlanDraft,
    SearchResponse,
    TraceRecord,
    ProviderRequest,
    new_id,
    utc_now,
)
from .workspace import ProjectWorkspace


def stable_json_hash(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _one_line(text: str, limit: int) -> str:
    cleaned = " ".join(text.strip().split())
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: max(0, limit - 3)].rstrip() + "..."


def _unique_refs(refs: Any) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for ref in refs:
        value = str(ref)
        if value in seen:
            continue
        seen.add(value)
        unique.append(value)
    return unique


MEMORY_TOKEN_RE = re.compile(r"[\w\u4e00-\u9fff]+", re.UNICODE)


def _parse_datetime(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _memory_tokens(text: str) -> list[str]:
    return [token.lower() for token in MEMORY_TOKEN_RE.findall(text) if token.strip()]


def _memory_embedding(text: str, dimensions: int) -> dict[str, float]:
    dims = max(8, dimensions)
    vector: dict[str, float] = {}
    for token in _memory_tokens(text):
        bucket = int(hashlib.sha256(token.encode("utf-8")).hexdigest()[:8], 16) % dims
        key = str(bucket)
        vector[key] = vector.get(key, 0.0) + 1.0
    norm = math.sqrt(sum(value * value for value in vector.values()))
    if norm <= 0:
        return {}
    return {key: round(value / norm, 8) for key, value in vector.items()}


def _cosine(left: dict[str, float], right: dict[str, float]) -> float:
    if not left or not right:
        return 0.0
    if len(left) > len(right):
        left, right = right, left
    return sum(value * right.get(key, 0.0) for key, value in left.items())


def _keyword_overlap(query: str, text: str) -> float:
    query_tokens = set(_memory_tokens(query))
    if not query_tokens:
        return 0.0
    text_tokens = set(_memory_tokens(text))
    return len(query_tokens & text_tokens) / len(query_tokens)


class ContextBuilder:
    def build_for_idea(
        self,
        idea: str,
        relevant_artifacts: list[str] | None = None,
        source_refs: list[str] | None = None,
        excluded_context_summary: str | None = None,
    ) -> ContextPacket:
        artifact_refs = relevant_artifacts or []
        return ContextPacket(
            context_id=new_id("ctx"),
            mode="idea_plan",
            task="Diagnose a raw research idea into five top-conference-oriented fields.",
            idea=idea,
            relevant_artifacts=artifact_refs,
            constraints=[
                "v0 uses the configured planner provider and records provider/tool traces.",
                "Do not claim novelty without literature retrieval.",
                "Produce diagnosis only; do not freeze a ResearchIdeaPlan.",
            ],
            source_refs=["user.idea", *(source_refs or [])],
            excluded_context_summary=(
                excluded_context_summary
                or "No prior artifacts or paper memory were retrieved."
            ),
            created_at=utc_now(),
        )


class MemoryManager:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.workspace = workspace

    def _config(self) -> MemoryConfig:
        return AgentConfig.load(self.workspace.project_root).memory

    def ensure_memory_entrypoint(self) -> Path:
        self.workspace.init()
        memory_map, metadata_path = self.project_memory_paths()
        if not memory_map.exists() or not metadata_path.exists():
            self.rebuild_project_memory_map()
        return memory_map

    def project_memory_paths(self) -> tuple[Path, Path]:
        self.workspace.init()
        memory_dir = self.workspace.workspace_dir / "memory"
        memory_dir.mkdir(parents=True, exist_ok=True)
        return memory_dir / "project-memory-map.md", memory_dir / "project-memory-map.json"

    def read_project_memory_map(self) -> ProjectMemoryMap:
        _, metadata_path = self.project_memory_paths()
        if not metadata_path.exists():
            return self.rebuild_project_memory_map()
        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        return ProjectMemoryMap.model_validate(payload)

    def read_project_memory_markdown(self) -> str:
        markdown_path, metadata_path = self.project_memory_paths()
        if not markdown_path.exists() or not metadata_path.exists():
            self.rebuild_project_memory_map()
        return markdown_path.read_text(encoding="utf-8")

    def rebuild_project_memory_map(self, thread_limit: int = 50) -> ProjectMemoryMap:
        self.workspace.init()
        artifact_manager = ArtifactManager(self.workspace)
        threads = self.workspace.list_thread_sessions(limit=thread_limit)
        for thread in threads:
            self._sync_thread_memory_records(thread.thread_id, artifact_manager)
        stale_count = self.recheck_stale_records()
        self.detect_conflicts()
        if stale_count:
            self._upsert_memory_record(
                MemoryRecord(
                    record_id=self._record_id("stale_recheck", self.workspace.project_id),
                    thread_id=None,
                    record_type="stale_recheck",
                    title="Stale memory recheck",
                    summary=f"Marked {stale_count} memory records as stale during rebuild.",
                    source_refs=["memory.recheck"],
                    artifact_refs=[],
                    status="active",
                    importance=2,
                    created_at=utc_now(),
                    updated_at=utc_now(),
                )
            )

        records = self.workspace.list_memory_records(limit=200)
        markdown_path, metadata_path = self.project_memory_paths()
        updated_at = utc_now()
        memory_map = ProjectMemoryMap(
            project_id=self.workspace.project_id,
            markdown_path=str(markdown_path),
            metadata_path=str(metadata_path),
            updated_at=updated_at,
            thread_count=len(threads),
            record_count=len(records),
            source_refs=_unique_refs(ref for record in records for ref in record.source_refs),
            records=records,
        )
        markdown_path.write_text(
            self._render_project_memory_map(memory_map, threads),
            encoding="utf-8",
        )
        metadata_path.write_text(
            json.dumps(memory_map.model_dump(mode="json"), ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        return memory_map

    def search_memory(
        self,
        query: str,
        thread_id: str | None = None,
        limit: int | None = None,
    ) -> MemorySearchResponse:
        config = self._config()
        requested_limit = limit or config.retrieval_limit
        records = self.workspace.list_memory_records(limit=300)
        if not records:
            self.rebuild_project_memory_map()
            records = self.workspace.list_memory_records(limit=300)
        index = self.workspace.list_memory_index()
        query_embedding = _memory_embedding(query, config.vector_dimensions)
        scored: list[MemorySearchResult] = []
        for record in records:
            if thread_id is not None and record.thread_id not in {thread_id, None}:
                continue
            search_text = self._record_search_text(record)
            indexed = index.get(record.record_id)
            embedding = (
                {
                    str(key): float(value)
                    for key, value in indexed.get("embedding", {}).items()
                }
                if indexed
                else _memory_embedding(search_text, config.vector_dimensions)
            )
            if indexed is None:
                self.workspace.upsert_memory_index(
                    record.record_id,
                    search_text,
                    embedding,
                    stable_json_hash(search_text),
                )
            vector_score = _cosine(query_embedding, embedding)
            keyword_score = _keyword_overlap(query, search_text)
            importance_score = record.importance / 5.0
            thread_bonus = 1.0 if thread_id is not None and record.thread_id == thread_id else 0.0
            stale_penalty = 0.20 if record.status == "stale" else 0.0
            conflict_bonus = 0.05 if record.status == "conflict" else 0.0
            score = (
                0.55 * vector_score
                + 0.30 * keyword_score
                + 0.10 * importance_score
                + 0.05 * thread_bonus
                + conflict_bonus
                - stale_penalty
            )
            if score <= 0:
                continue
            scored.append(
                MemorySearchResult(
                    record=record,
                    score=round(score, 6),
                    vector_score=round(vector_score, 6),
                    keyword_score=round(keyword_score, 6),
                    reason=self._search_reason(record, vector_score, keyword_score),
                )
            )
        scored.sort(key=lambda item: (-item.score, -item.record.importance, item.record.updated_at))
        return MemorySearchResponse(
            query=query,
            thread_id=thread_id,
            results=scored[:requested_limit],
        )

    def recheck_stale_records(self) -> int:
        config = self._config()
        if not config.stale_recheck_enabled:
            return 0
        ttl_days = max(1, config.paper_evidence_ttl_days)
        now = datetime.now(timezone.utc)
        stale_count = 0
        for record in self.workspace.list_memory_records(record_type="paper_evidence", limit=500):
            updated_at = _parse_datetime(record.updated_at)
            if updated_at is None:
                continue
            if (now - updated_at).days < ttl_days:
                continue
            if record.status != "stale":
                self.workspace.update_memory_record_status(record.record_id, "stale")
                stale_count += 1
        return stale_count

    def detect_conflicts(self) -> list[ConflictRecord]:
        config = self._config()
        if not config.conflict_detection_enabled:
            return []
        conflicts: list[ConflictRecord] = []
        now = utc_now()
        for thread in self.workspace.list_thread_sessions(limit=200):
            reviews = self.workspace.list_idea_reviews(thread.thread_id)
            decisions = {str(review["decision"]) for review in reviews}
            if len(decisions) > 1:
                conflict = ConflictRecord(
                    conflict_id=self._record_id("conflict.review", thread.thread_id),
                    thread_id=thread.thread_id,
                    conflict_type="review_decision_conflict",
                    status="open",
                    summary=(
                        "This thread has multiple idea review decisions: "
                        f"{', '.join(sorted(decisions))}. Treat the latest decision as "
                        "active but inspect the older review before freezing."
                    ),
                    record_refs=[
                        self._record_id("idea_review", str(review["review_id"]))
                        for review in reviews[:5]
                    ],
                    source_refs=[f"review:{review['review_id']}" for review in reviews[:5]],
                    created_at=now,
                    updated_at=now,
                )
                self.workspace.upsert_conflict_record(conflict)
                conflicts.append(conflict)

            latest_review = reviews[0] if reviews else None
            plan_artifact = self.workspace.latest_plan_artifact_for_thread(thread.thread_id)
            if (
                latest_review is not None
                and plan_artifact is not None
                and plan_artifact.artifact_type == "ResearchIdeaPlan"
                and latest_review["decision"] != "Advance"
            ):
                conflict = ConflictRecord(
                    conflict_id=self._record_id("conflict.freeze_gate", thread.thread_id),
                    thread_id=thread.thread_id,
                    conflict_type="freeze_gate_conflict",
                    status="open",
                    summary=(
                        "A ResearchIdeaPlan is frozen while the latest idea review decision "
                        f"is {latest_review['decision']}, not Advance."
                    ),
                    record_refs=[
                        self._record_id("current_plan", thread.thread_id),
                        self._record_id("idea_review", str(latest_review["review_id"])),
                    ],
                    source_refs=[
                        f"artifact:{plan_artifact.artifact_id}",
                        f"review:{latest_review['review_id']}",
                    ],
                    created_at=now,
                    updated_at=now,
                )
                self.workspace.upsert_conflict_record(conflict)
                conflicts.append(conflict)

            stale_evidence = [
                record
                for record in self.workspace.list_memory_records(
                    thread_id=thread.thread_id,
                    record_type="paper_evidence",
                    limit=50,
                )
                if record.status == "stale"
            ]
            if stale_evidence:
                conflict = ConflictRecord(
                    conflict_id=self._record_id("conflict.stale_evidence", thread.thread_id),
                    thread_id=thread.thread_id,
                    conflict_type="stale_evidence_conflict",
                    status="open",
                    summary=(
                        f"{len(stale_evidence)} paper evidence records are stale. "
                        "Re-run search before making novelty or latest-paper claims."
                    ),
                    record_refs=[record.record_id for record in stale_evidence[:10]],
                    source_refs=[
                        ref
                        for record in stale_evidence[:10]
                        for ref in record.source_refs[:3]
                    ],
                    created_at=now,
                    updated_at=now,
                )
                self.workspace.upsert_conflict_record(conflict)
                conflicts.append(conflict)
        return conflicts

    def _upsert_memory_record(self, record: MemoryRecord) -> None:
        self.workspace.upsert_memory_record(record)
        search_text = self._record_search_text(record)
        config = self._config()
        self.workspace.upsert_memory_index(
            record.record_id,
            search_text,
            _memory_embedding(search_text, config.vector_dimensions),
            stable_json_hash(search_text),
            updated_at=record.updated_at,
        )

    def _record_search_text(self, record: MemoryRecord) -> str:
        return "\n".join(
            [
                record.title,
                record.summary,
                record.record_type,
                record.status,
                " ".join(record.source_refs),
                " ".join(record.artifact_refs),
            ]
        )

    def _search_reason(
        self,
        record: MemoryRecord,
        vector_score: float,
        keyword_score: float,
    ) -> str:
        reasons = [record.record_type]
        if vector_score > 0.15:
            reasons.append("vector similarity")
        if keyword_score > 0:
            reasons.append("keyword overlap")
        if record.status != "active":
            reasons.append(f"status={record.status}")
        return ", ".join(reasons)

    def _sync_thread_memory_records(
        self,
        thread_id: str,
        artifact_manager: "ArtifactManager",
    ) -> None:
        now = utc_now()
        plan_artifact = self.workspace.latest_plan_artifact_for_thread(thread_id)
        if plan_artifact is not None:
            try:
                if plan_artifact.artifact_type == "ResearchIdeaPlan":
                    _, plan = artifact_manager.read_research_idea_plan(plan_artifact.artifact_id)
                    diagnosis = plan.diagnosis
                    status = plan.status
                else:
                    _, draft = artifact_manager.read_research_idea_draft(plan_artifact.artifact_id)
                    diagnosis = draft.diagnosis
                    status = "draft"
                self._upsert_memory_record(
                    MemoryRecord(
                        record_id=self._record_id("current_plan", thread_id),
                        thread_id=thread_id,
                        record_type="current_plan",
                        title=f"Current idea plan ({status})",
                        summary=(
                            f"Problem: {_one_line(diagnosis.problem, 260)}\n"
                            f"Gap: {_one_line(diagnosis.gap, 260)}\n"
                            "Candidate Mechanism: "
                            f"{_one_line(diagnosis.candidate_mechanism, 260)}\n"
                            f"Main Uncertainty: {_one_line(diagnosis.main_uncertainty, 260)}"
                        ),
                        source_refs=[f"artifact:{plan_artifact.artifact_id}"],
                        artifact_refs=[plan_artifact.artifact_id],
                        status="active",
                        importance=5,
                        created_at=now,
                        updated_at=now,
                    )
                )
            except Exception as exc:
                self._upsert_memory_record(
                    MemoryRecord(
                        record_id=self._record_id("current_plan", thread_id),
                        thread_id=thread_id,
                        record_type="current_plan",
                        title="Current idea plan read error",
                        summary=_one_line(str(exc), 400),
                        source_refs=[f"artifact:{plan_artifact.artifact_id}"],
                        artifact_refs=[plan_artifact.artifact_id],
                        status="conflict",
                        importance=5,
                        created_at=now,
                        updated_at=now,
                    )
                )

        review = self.workspace.latest_idea_review(thread_id)
        if review is not None:
            self._upsert_memory_record(
                MemoryRecord(
                    record_id=self._record_id("idea_review", review["review_id"]),
                    thread_id=thread_id,
                    record_type="idea_review",
                    title=f"Idea review: {review['decision']}",
                    summary=_one_line(str(review.get("notes") or "No notes."), 600),
                    source_refs=[
                        f"review:{review['review_id']}",
                        f"artifact:{review['artifact_id']}",
                    ],
                    artifact_refs=[review["artifact_id"]],
                    status="active",
                    importance=4,
                    created_at=review["created_at"],
                    updated_at=now,
                )
            )

        for artifact in self.workspace.latest_artifacts_for_thread(
            thread_id,
            "PaperSearchEvidence",
            limit=5,
        ):
            try:
                _, evidence = artifact_manager.read_paper_search_evidence(artifact.artifact_id)
                response = evidence.search_response
                retrieved_at = response.retrieved_at
                titles = [
                    _one_line(result.title, 140)
                    for result in response.results[:5]
                    if result.title
                ]
                summary = (
                    f"Query: {_one_line(evidence.query, 220)}\n"
                    f"Source: {response.source}; results: {len(response.results)}; "
                    f"retrieved_at: {response.retrieved_at}\n"
                    f"Top titles: {' | '.join(titles) if titles else 'None'}"
                )
                if response.error:
                    summary += f"\nError: {_one_line(response.error, 260)}"
            except Exception as exc:
                retrieved_at = artifact.created_at
                summary = f"Paper evidence read error: {_one_line(str(exc), 400)}"
            self._upsert_memory_record(
                MemoryRecord(
                    record_id=self._record_id("paper_evidence", artifact.artifact_id),
                    thread_id=thread_id,
                    record_type="paper_evidence",
                    title=artifact.title,
                    summary=summary,
                    source_refs=[f"paper_evidence:{artifact.artifact_id}"],
                    artifact_refs=[artifact.artifact_id],
                    status="active",
                    importance=3,
                    created_at=artifact.created_at,
                    updated_at=retrieved_at,
                )
            )

        summary = self.read_conversation_summary(thread_id)
        if summary is not None:
            self._upsert_memory_record(
                MemoryRecord(
                    record_id=self._record_id("conversation_summary", thread_id),
                    thread_id=thread_id,
                    record_type="conversation_summary",
                    title="Conversation summary",
                    summary=_one_line(summary.summary_text, 900),
                    source_refs=summary.source_refs,
                    artifact_refs=[],
                    status="active",
                    importance=3,
                    created_at=summary.created_at,
                    updated_at=summary.updated_at,
                )
            )

    def _record_id(self, record_type: str, source: str) -> str:
        digest = stable_json_hash({"record_type": record_type, "source": source})[:24]
        return f"memory_{digest}"

    def _render_project_memory_map(
        self,
        memory_map: ProjectMemoryMap,
        threads: list[Any],
    ) -> str:
        lines = [
            "# Project Memory Map",
            "",
            "This file is a generated navigation layer for Academic Agent memory. "
            "It points to artifacts, summaries, reviews, traces, and paper-search evidence; "
            "it does not replace the full local transcript.",
            "",
            f"- Project: `{memory_map.project_id}`",
            f"- Updated: `{memory_map.updated_at}`",
            f"- Threads: `{memory_map.thread_count}`",
            f"- Memory records: `{memory_map.record_count}`",
            "",
            "## Current Research State",
        ]
        plan_records = [record for record in memory_map.records if record.record_type == "current_plan"]
        if not plan_records:
            lines.append("- No current plan records yet.")
        for record in plan_records[:10]:
            title = self._thread_title(record.thread_id, threads)
            lines.extend(
                [
                    f"### {title}",
                    f"- Thread: `{record.thread_id}`",
                    f"- Record: `{record.record_id}`",
                    f"- Status: `{record.status}`; importance: `{record.importance}`",
                    f"- Artifacts: {', '.join(f'`{ref}`' for ref in record.artifact_refs) or '`None`'}",
                    "",
                    record.summary,
                    "",
                ]
            )

        lines.extend(["## Important Decisions"])
        review_records = [record for record in memory_map.records if record.record_type == "idea_review"]
        if not review_records:
            lines.append("- No review decisions recorded yet.")
        for record in review_records[:20]:
            lines.append(
                f"- `{record.updated_at}` `{record.record_id}` {record.title}: "
                f"{_one_line(record.summary, 220)}"
            )

        lines.extend(["", "## Where To Look"])
        for thread in threads[:20]:
            lines.append(
                f"- `{thread.thread_id}` {thread.title} "
                f"({thread.session_status}, updated `{thread.updated_at}`)"
            )
        evidence_records = [record for record in memory_map.records if record.record_type == "paper_evidence"]
        if evidence_records:
            lines.extend(["", "## Paper Evidence Index"])
            for record in evidence_records[:20]:
                lines.append(
                    f"- `{record.record_id}` {record.title}: {_one_line(record.summary, 220)}"
                )

        summary_records = [
            record for record in memory_map.records if record.record_type == "conversation_summary"
        ]
        if summary_records:
            lines.extend(["", "## Conversation Summaries"])
            for record in summary_records[:20]:
                lines.append(
                    f"- `{record.thread_id}` `{record.record_id}`: {_one_line(record.summary, 220)}"
                )

        conflicts = self.workspace.list_conflict_records(status="open", limit=50)
        lines.extend(["", "## Conflicts"])
        if not conflicts:
            lines.append("- No open conflicts.")
        for conflict in conflicts:
            lines.append(
                f"- `{conflict.conflict_id}` {conflict.conflict_type}: "
                f"{_one_line(conflict.summary, 260)}"
            )

        lines.extend(
            [
                "",
                "## Stale / Needs Recheck",
                "- Venue rules, model capabilities, provider API behavior, paper status, and benchmark SOTA should be rechecked before use.",
            ]
        )
        return "\n".join(lines).rstrip() + "\n"

    def _thread_title(self, thread_id: str | None, threads: list[Any]) -> str:
        if thread_id is None:
            return "Project-level memory"
        for thread in threads:
            if thread.thread_id == thread_id:
                return thread.title
        return thread_id

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

    def freeze_research_idea_plan(
        self,
        source_metadata: ArtifactMetadata,
        draft: ResearchIdeaPlanDraft,
    ) -> tuple[ArtifactMetadata, ResearchIdeaPlan]:
        self.workspace.ensure_initialized()
        frozen_at = utc_now()
        artifact_id = new_id("artifact")
        markdown_path = self.workspace.workspace_dir / "artifacts" / f"{artifact_id}.md"
        metadata_path = self.workspace.workspace_dir / "artifacts" / f"{artifact_id}.json"
        plan = ResearchIdeaPlan(
            plan_id=new_id("plan"),
            artifact_id=artifact_id,
            source_draft_artifact_id=source_metadata.artifact_id,
            source_run_id=draft.source_run_id,
            title="ResearchIdeaPlan",
            diagnosis=draft.diagnosis,
            context_id=draft.context_id,
            markdown_path=str(markdown_path),
            metadata_path=str(metadata_path),
            status="frozen",
            frozen_at=frozen_at,
            created_at=frozen_at,
        )
        metadata = ArtifactMetadata(
            artifact_id=artifact_id,
            artifact_type="ResearchIdeaPlan",
            status="frozen",
            title=plan.title,
            path=str(markdown_path),
            metadata_path=str(metadata_path),
            schema_version="v1",
            source_run_id=draft.source_run_id,
            trace_refs=source_metadata.trace_refs,
            created_at=frozen_at,
        )
        markdown_path.write_text(self._render_frozen_plan_markdown(plan), encoding="utf-8")
        metadata_path.write_text(
            json.dumps(
                {
                    "metadata": metadata.model_dump(mode="json"),
                    "plan": plan.model_dump(mode="json"),
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        self.workspace.insert_artifact(metadata)
        return metadata, plan

    def read_research_idea_plan(
        self,
        artifact_id: str,
    ) -> tuple[ArtifactMetadata, ResearchIdeaPlan]:
        metadata = self.workspace.get_artifact_metadata(artifact_id)
        payload = json.loads(Path(metadata.metadata_path).read_text(encoding="utf-8"))
        return metadata, ResearchIdeaPlan.model_validate(payload["plan"])

    def write_paper_search_evidence(
        self,
        run_id: str,
        search_response: SearchResponse,
        trace_refs: list[str] | None = None,
    ) -> tuple[ArtifactMetadata, PaperSearchEvidence]:
        self.workspace.ensure_initialized()
        artifact_id = new_id("artifact")
        markdown_path = self.workspace.workspace_dir / "artifacts" / f"{artifact_id}.md"
        metadata_path = self.workspace.workspace_dir / "artifacts" / f"{artifact_id}.json"
        created_at = utc_now()
        evidence = PaperSearchEvidence(
            evidence_id=new_id("paper_evidence"),
            artifact_id=artifact_id,
            source_run_id=run_id,
            query=search_response.query,
            search_response=search_response,
            markdown_path=str(markdown_path),
            metadata_path=str(metadata_path),
            created_at=created_at,
        )
        metadata = ArtifactMetadata(
            artifact_id=artifact_id,
            artifact_type="PaperSearchEvidence",
            status="frozen",
            title=f"PaperSearchEvidence: {search_response.query[:60]}",
            path=str(markdown_path),
            metadata_path=str(metadata_path),
            schema_version="v1",
            source_run_id=run_id,
            trace_refs=trace_refs or [],
            created_at=created_at,
        )
        markdown_path.write_text(self._render_paper_search_markdown(evidence), encoding="utf-8")
        metadata_path.write_text(
            json.dumps(
                {
                    "metadata": metadata.model_dump(mode="json"),
                    "evidence": evidence.model_dump(mode="json"),
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        self.workspace.insert_artifact(metadata)
        return metadata, evidence

    def read_paper_search_evidence(
        self,
        artifact_id: str,
    ) -> tuple[ArtifactMetadata, PaperSearchEvidence]:
        metadata = self.workspace.get_artifact_metadata(artifact_id)
        payload = json.loads(Path(metadata.metadata_path).read_text(encoding="utf-8"))
        return metadata, PaperSearchEvidence.model_validate(payload["evidence"])

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

    def _render_frozen_plan_markdown(self, plan: ResearchIdeaPlan) -> str:
        evidence = "\n".join(f"- {item}" for item in plan.diagnosis.evidence_needed)
        questions = "\n".join(f"- {item}" for item in plan.diagnosis.clarifying_questions)
        if not questions:
            questions = "- None"
        return (
            "# ResearchIdeaPlan\n\n"
            f"- Status: `{plan.status}`\n"
            f"- Frozen at: `{plan.frozen_at}`\n"
            f"- Source draft: `{plan.source_draft_artifact_id}`\n"
            f"- Source run: `{plan.source_run_id}`\n"
            f"- Context: `{plan.context_id}`\n\n"
            "## Problem\n"
            f"{plan.diagnosis.problem}\n\n"
            "## Gap\n"
            f"{plan.diagnosis.gap}\n\n"
            "## Candidate Mechanism\n"
            f"{plan.diagnosis.candidate_mechanism}\n\n"
            "## Evidence Needed\n"
            f"{evidence}\n\n"
            "## Main Uncertainty\n"
            f"{plan.diagnosis.main_uncertainty}\n\n"
            "## Clarifying Questions\n"
            f"{questions}\n"
        )

    def _render_paper_search_markdown(self, evidence: PaperSearchEvidence) -> str:
        response = evidence.search_response
        lines = [
            "# PaperSearchEvidence",
            "",
            f"- Query: `{evidence.query}`",
            f"- Source: `{response.source}`",
            f"- Retrieved at: `{response.retrieved_at}`",
            f"- Error: `{response.error or 'None'}`",
            "",
            "## Results",
        ]
        if not response.results:
            lines.append("- No results.")
        for index, item in enumerate(response.results, start=1):
            authors = ", ".join(item.authors[:5]) if item.authors else "Unknown authors"
            lines.extend(
                [
                    f"### {index}. {item.title}",
                    f"- Source: `{item.source}`",
                    f"- URL: {item.url}",
                    f"- Authors: {authors}",
                    f"- Published: `{item.published_at or 'unknown'}`",
                    "",
                    item.snippet or "No snippet.",
                    "",
                ]
            )
        return "\n".join(lines).rstrip() + "\n"
