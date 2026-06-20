from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex}"


JsonObject = dict[str, Any]
ProviderName = Literal["mock", "openai", "anthropic", "openai_compatible", "deepseek"]
ProviderProfileName = Literal["planner", "reviewer", "writer", "extractor", "embedder"]
ReasoningEffort = Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]
ReasoningSummary = Literal["auto", "concise", "detailed"]
SearchSource = Literal[
    "arxiv",
    "openalex",
    "brave",
    "tavily",
    "serper",
    "serpapi",
    "duckduckgo",
]
PaperSearchSort = Literal["relevance", "submitted_date", "hybrid"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProjectInitRequest(StrictModel):
    project_root: str | None = None


class ProjectStatus(StrictModel):
    project_id: str
    project_root: str
    workspace_dir: str
    db_path: str
    initialized: bool
    directories: list[str] = Field(default_factory=list)


class CoreCapabilitiesResponse(StrictModel):
    version: str
    capabilities: list[str] = Field(default_factory=list)


class WorkflowThread(StrictModel):
    thread_id: str
    project_id: str
    name: str | None = None
    created_at: str


class ThreadSessionSummary(StrictModel):
    thread_id: str
    project_id: str
    title: str
    name: str | None = None
    created_at: str
    updated_at: str
    message_count: int
    latest_run_id: str | None = None
    latest_status: str | None = None
    session_status: str | None = None
    latest_artifact_type: str | None = None
    latest_artifact_status: str | None = None


class ThreadMessage(StrictModel):
    message_id: str
    thread_id: str
    role: Literal["user", "assistant", "tool"]
    content: str
    run_id: str | None = None
    created_at: str
    ordinal: int
    tool_call_id: str | None = None
    tool_name: str | None = None
    tool_args: JsonObject | None = None
    parent_message_id: str | None = None


class ModeRun(StrictModel):
    run_id: str
    thread_id: str
    mode: Literal["idea_plan"]
    status: Literal["created", "running", "completed", "failed", "cancelled"]
    input_idea: str
    artifact_id: str | None = None
    error: str | None = None
    created_at: str
    updated_at: str


class Diagnosis(StrictModel):
    problem: str
    gap: str
    candidate_mechanism: str
    evidence_needed: list[str]
    main_uncertainty: str
    clarifying_questions: list[str] = Field(default_factory=list)


class ToolDefinition(StrictModel):
    name: str
    description: str
    parameters: JsonObject


class ToolCall(StrictModel):
    call_id: str
    name: str
    arguments: JsonObject


class ToolResult(StrictModel):
    call_id: str
    name: str
    result: JsonObject | None = None
    error: str | None = None


class SearchResult(StrictModel):
    source: SearchSource
    title: str
    snippet: str = ""
    url: str
    retrieved_at: str
    external_id: str | None = None
    authors: list[str] = Field(default_factory=list)
    published_at: str | None = None
    updated_at: str | None = None
    pdf_url: str | None = None
    metadata: JsonObject = Field(default_factory=dict)


class SearchResponse(StrictModel):
    query: str
    source: str
    results: list[SearchResult] = Field(default_factory=list)
    retrieved_at: str
    error: str | None = None


def default_search_sources() -> list[SearchSource]:
    return ["arxiv", "openalex"]


class PaperSearchRequest(StrictModel):
    query: str = Field(min_length=1)
    max_results: int = Field(default=8, ge=1, le=25)
    sources: list[SearchSource] = Field(default_factory=default_search_sources)
    sort_by: PaperSearchSort = "hybrid"


class SearchProviderStatus(StrictModel):
    source: SearchSource
    enabled: bool
    configured: bool
    api_key_env: str | None = None
    has_api_key: bool
    base_url: str | None = None


class SearchProvidersResponse(StrictModel):
    paper_sources: list[SearchSource] = Field(default_factory=list)
    web_sources: list[SearchSource] = Field(default_factory=list)
    providers: list[SearchProviderStatus] = Field(default_factory=list)


class ContextPacket(StrictModel):
    context_id: str
    mode: Literal["idea_plan"]
    task: str
    idea: str
    relevant_artifacts: list[str] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)
    source_refs: list[str] = Field(default_factory=list)
    excluded_context_summary: str
    created_at: str


class ConversationSummary(StrictModel):
    summary_id: str
    thread_id: str
    status: Literal["frozen"]
    schema_version: str
    summary_source: Literal["deterministic", "llm"] = "deterministic"
    provider: ProviderName | None = None
    model: str | None = None
    summary_text: str
    source_refs: list[str] = Field(default_factory=list)
    covered_until_ordinal: int
    covered_message_count: int
    markdown_path: str
    metadata_path: str
    created_at: str
    updated_at: str


class MemoryRecord(StrictModel):
    record_id: str
    thread_id: str | None = None
    record_type: Literal[
        "current_plan",
        "idea_review",
        "paper_evidence",
        "conversation_summary",
        "stale_recheck",
    ]
    title: str
    summary: str
    source_refs: list[str] = Field(default_factory=list)
    artifact_refs: list[str] = Field(default_factory=list)
    status: Literal["active", "stale", "conflict"] = "active"
    importance: int = Field(default=3, ge=1, le=5)
    created_at: str
    updated_at: str


class ProjectMemoryMap(StrictModel):
    project_id: str
    markdown_path: str
    metadata_path: str
    updated_at: str
    thread_count: int
    record_count: int
    source_refs: list[str] = Field(default_factory=list)
    records: list[MemoryRecord] = Field(default_factory=list)


class MemorySearchResult(StrictModel):
    record: MemoryRecord
    score: float
    vector_score: float
    keyword_score: float
    reason: str


class MemorySearchResponse(StrictModel):
    query: str
    thread_id: str | None = None
    results: list[MemorySearchResult] = Field(default_factory=list)


class ConflictRecord(StrictModel):
    conflict_id: str
    thread_id: str | None = None
    conflict_type: Literal[
        "review_decision_conflict",
        "freeze_gate_conflict",
        "stale_evidence_conflict",
    ]
    status: Literal["open", "resolved"] = "open"
    summary: str
    record_refs: list[str] = Field(default_factory=list)
    source_refs: list[str] = Field(default_factory=list)
    created_at: str
    updated_at: str


class ConflictListResponse(StrictModel):
    conflicts: list[ConflictRecord] = Field(default_factory=list)


class MemoryRecheckResponse(StrictModel):
    stale_count: int
    conflict_count: int
    memory_map: ProjectMemoryMap


class ArtifactMetadata(StrictModel):
    artifact_id: str
    artifact_type: Literal["ResearchIdeaPlanDraft", "ResearchIdeaPlan", "PaperSearchEvidence"]
    status: Literal["draft", "frozen"]
    title: str
    path: str
    metadata_path: str
    schema_version: str
    source_run_id: str
    trace_refs: list[str] = Field(default_factory=list)
    created_at: str


class ResearchIdeaPlanDraft(StrictModel):
    artifact_id: str
    title: str
    source_run_id: str
    diagnosis: Diagnosis
    context_id: str
    markdown_path: str
    metadata_path: str
    created_at: str


class ResearchIdeaPlan(StrictModel):
    plan_id: str
    artifact_id: str
    source_draft_artifact_id: str
    source_run_id: str
    title: str
    diagnosis: Diagnosis
    context_id: str
    markdown_path: str
    metadata_path: str
    status: Literal["frozen"]
    frozen_at: str
    created_at: str


class PaperSearchEvidence(StrictModel):
    evidence_id: str
    artifact_id: str
    source_run_id: str
    query: str
    search_response: SearchResponse
    markdown_path: str
    metadata_path: str
    created_at: str


class SSEEvent(StrictModel):
    event_id: str
    run_id: str
    event_type: str
    payload: JsonObject = Field(default_factory=dict)
    created_at: str
    ordinal: int


class TraceRecord(StrictModel):
    trace_id: str
    run_id: str
    trace_type: str
    path: str
    payload_hash: str
    created_at: str


class ProviderRequest(StrictModel):
    request_id: str
    provider: ProviderName
    model: str
    profile: ProviderProfileName
    messages: list[JsonObject]
    prompt_version: str
    input_hash: str
    created_at: str


class ProviderResponse(StrictModel):
    response_id: str
    request_id: str
    provider: ProviderName
    model: str
    output: JsonObject
    usage: JsonObject = Field(default_factory=dict)
    cached: bool = False
    provider_request_id: str | None = None
    created_at: str


class AppCacheRecord(StrictModel):
    cache_key: str
    cache_type: str
    provider: ProviderName
    model: str
    profile: ProviderProfileName
    prompt_version: str
    input_hash: str
    payload_json: JsonObject
    created_at: str


class AppCacheSummaryRecord(StrictModel):
    cache_key: str
    cache_type: str
    provider: ProviderName
    model: str
    profile: ProviderProfileName
    prompt_version: str
    input_hash: str
    created_at: str


class AppCacheListResponse(StrictModel):
    records: list[AppCacheSummaryRecord] = Field(default_factory=list)


class AppCacheClearResponse(StrictModel):
    deleted: int


class ProviderProfileConfig(StrictModel):
    profile: ProviderProfileName
    provider: ProviderName
    model: str
    api_key_env: str | None = None
    base_url: str | None = None
    max_output_tokens: int = Field(default=900, ge=1)
    temperature: float | None = Field(default=0.2, ge=0)
    reasoning_effort: ReasoningEffort | None = None
    reasoning_summary: ReasoningSummary | None = None
    max_agent_iterations: int = Field(default=5, ge=1, le=20)


class ProviderProfileStatus(StrictModel):
    profile: ProviderProfileName
    provider: ProviderName
    model: str
    api_key_env: str | None = None
    has_api_key: bool
    base_url: str | None = None
    reasoning_effort: ReasoningEffort | None = None
    reasoning_summary: ReasoningSummary | None = None
    live_enabled: bool
    will_use_live: bool


class ProviderProfilesResponse(StrictModel):
    profiles: list[ProviderProfileStatus] = Field(default_factory=list)
    config_sources: list[str] = Field(default_factory=list)


class CreateIdeaPlanRunRequest(StrictModel):
    idea: str = Field(min_length=1)
    thread_id: str | None = None


class ContinueIdeaPlanThreadRequest(StrictModel):
    content: str = Field(min_length=1)


class RenameThreadRequest(StrictModel):
    name: str = Field(min_length=1)


class CreateIdeaPlanRunResponse(StrictModel):
    run: ModeRun
    artifact: ArtifactMetadata
    draft: ResearchIdeaPlanDraft


class StartIdeaPlanRunResponse(StrictModel):
    run: ModeRun
    run_url: str
    events_url: str


class RunListResponse(StrictModel):
    runs: list[ModeRun] = Field(default_factory=list)


class RunResultResponse(StrictModel):
    run: ModeRun
    artifact: ArtifactMetadata
    draft: ResearchIdeaPlanDraft
    thread: WorkflowThread
    messages: list[ThreadMessage] = Field(default_factory=list)


class CurrentIdeaPlanResponse(StrictModel):
    thread: WorkflowThread
    artifact: ArtifactMetadata | None = None
    draft: ResearchIdeaPlanDraft | ResearchIdeaPlan | None = None
    session_status: str
    latest_run_id: str | None = None
    latest_status: str | None = None


class FreezeIdeaPlanResponse(StrictModel):
    thread: WorkflowThread
    artifact: ArtifactMetadata
    plan: ResearchIdeaPlan


class ReviewIdeaPlanRequest(StrictModel):
    decision: Literal["Reject", "Revise", "Advance"]
    notes: str | None = None


class ReviewIdeaPlanResponse(StrictModel):
    thread: WorkflowThread
    decision: Literal["Reject", "Revise", "Advance"]
    session_status: str
    notes: str | None = None


class ThreadMessagesResponse(StrictModel):
    thread: WorkflowThread
    messages: list[ThreadMessage] = Field(default_factory=list)


class ContextUsageResponse(StrictModel):
    thread_id: str | None = None
    model: str
    context_window_tokens: int
    history_token_budget: int
    compact_threshold_tokens: int
    compact_trigger_ratio: float
    max_history_tokens: int
    estimated_thread_tokens: int
    estimated_artifact_tokens: int
    estimated_draft_tokens: int
    estimated_total_tokens: int
    estimated_context_tokens: int
    usage_ratio: float
    threshold_ratio: float
    should_compact: bool
    compact_reason: str
    context_focus: str
    total_message_count: int
    recent_message_count: int
    older_message_count: int
    important_message_count: int
    artifact_source_count: int
    chars_per_token: float


class ArtifactContextResponse(StrictModel):
    prompt_text: str
    source_refs: list[str] = Field(default_factory=list)
    estimated_tokens: int
    token_budget: int


class ThreadContextResponse(StrictModel):
    thread: WorkflowThread
    artifact_context: ArtifactContextResponse
    content: str


class ThreadListResponse(StrictModel):
    threads: list[ThreadSessionSummary] = Field(default_factory=list)


class ArtifactReadResponse(StrictModel):
    metadata: ArtifactMetadata
    content: str


class TraceReadResponse(StrictModel):
    trace: TraceRecord
    payload: JsonObject


class MemoryMapResponse(StrictModel):
    memory_map: ProjectMemoryMap
    content: str


SCHEMA_MODELS: tuple[type[BaseModel], ...] = (
    ProjectInitRequest,
    ProjectStatus,
    CoreCapabilitiesResponse,
    WorkflowThread,
    ThreadSessionSummary,
    ThreadMessage,
    ModeRun,
    Diagnosis,
    ToolDefinition,
    ToolCall,
    ToolResult,
    SearchResult,
    SearchResponse,
    PaperSearchRequest,
    SearchProviderStatus,
    SearchProvidersResponse,
    ContextPacket,
    ConversationSummary,
    MemoryRecord,
    ProjectMemoryMap,
    MemorySearchResult,
    MemorySearchResponse,
    ConflictRecord,
    ConflictListResponse,
    MemoryRecheckResponse,
    ArtifactMetadata,
    ResearchIdeaPlanDraft,
    ResearchIdeaPlan,
    PaperSearchEvidence,
    SSEEvent,
    TraceRecord,
    ProviderRequest,
    ProviderResponse,
    ProviderProfileConfig,
    ProviderProfileStatus,
    ProviderProfilesResponse,
    AppCacheRecord,
    AppCacheSummaryRecord,
    AppCacheListResponse,
    AppCacheClearResponse,
    CreateIdeaPlanRunRequest,
    ContinueIdeaPlanThreadRequest,
    RenameThreadRequest,
    CreateIdeaPlanRunResponse,
    StartIdeaPlanRunResponse,
    RunListResponse,
    RunResultResponse,
    CurrentIdeaPlanResponse,
    FreezeIdeaPlanResponse,
    ReviewIdeaPlanRequest,
    ReviewIdeaPlanResponse,
    ThreadMessagesResponse,
    ContextUsageResponse,
    ArtifactContextResponse,
    ThreadContextResponse,
    ThreadListResponse,
    ArtifactReadResponse,
    TraceReadResponse,
    MemoryMapResponse,
)
