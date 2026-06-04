from __future__ import annotations

import json
import re
import time
from typing import Any, TypedDict

from langgraph.graph import END, StateGraph

from .config import AgentConfig, ContextCompactionConfig
from .harness import ArtifactManager, CacheManager, ContextBuilder, MemoryManager, TraceRecorder
from .providers import (
    ProviderError,
    _agent_system_prompt,
    _diagnosis_from_text,
    create_idea_diagnosis_provider,
)
from .search import create_default_search_engine
from .schemas import (
    CreateIdeaPlanRunResponse,
    ContextUsageResponse,
    ConversationSummary,
    Diagnosis,
    ModeRun,
    ProviderResponse,
    SearchResponse,
    ThreadMessage,
    new_id,
    utc_now,
)
from .tools import get_default_tools
from .workspace import ProjectWorkspace


class RunCancelled(RuntimeError):
    pass


class HistoryContextPacket(TypedDict):
    compacted: bool
    total_message_count: int
    older_message_count: int
    recent_message_count: int
    important_message_count: int
    prompt_text: str
    source_refs: list[str]
    artifact_source_refs: list[str]
    important_source_refs: list[str]
    excluded_context_summary: str
    compact_reason: str
    context_focus: str
    estimated_history_tokens: int
    history_token_budget: int
    compact_threshold_tokens: int
    context_window_tokens: int
    recent_token_budget: int
    important_token_budget: int
    summary_token_budget: int
    artifact_context_tokens: int
    artifact_token_budget: int
    persistent_summary_id: str | None
    persistent_summary_path: str | None
    persistent_summary_covered_until_ordinal: int | None


class ArtifactContextPacket(TypedDict):
    prompt_text: str
    source_refs: list[str]
    estimated_tokens: int
    token_budget: int


class IdeaPlanState(TypedDict, total=False):
    idea: str
    run_id: str
    thread_id: str
    messages: list[dict[str, Any]]
    iteration: int
    tool_calls: list[dict[str, Any]]
    context: dict[str, Any]
    provider_response: dict[str, Any]
    trace_id: str
    artifact_id: str
    draft: dict[str, Any]
    diagnosis: dict[str, Any]
    history_context: HistoryContextPacket


class IdeaPlanRunner:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.workspace = workspace
        self.context_builder = ContextBuilder()
        self.memory_manager = MemoryManager(workspace)
        self.cache_manager = CacheManager(workspace)
        self.trace_recorder = TraceRecorder(workspace)
        self.artifact_manager = ArtifactManager(workspace)
        self.config = AgentConfig.load(workspace.project_root)
        self.provider_profile = self.config.profile("planner")
        self.provider = create_idea_diagnosis_provider(self.provider_profile, self.config.env)
        self.tool_registry = get_default_tools(
            create_default_search_engine(self.config.search, self.config.env)
        )
        self.max_iterations = self.provider_profile.max_agent_iterations

    def create_run(self, idea: str, thread_id: str | None = None) -> ModeRun:
        self.workspace.init()
        self.memory_manager.ensure_memory_entrypoint()
        thread = self.workspace.create_thread(thread_id)
        run = self.workspace.create_run(thread.thread_id, idea)
        self.workspace.add_message(thread.thread_id, "user", idea, run.run_id)
        self.workspace.add_event(
            run.run_id,
            "run.created",
            {"mode": run.mode, "thread_id": run.thread_id},
        )
        return run

    def execute_run(self, run_id: str) -> CreateIdeaPlanRunResponse:
        run = self.workspace.get_run(run_id)
        if run.status != "created":
            raise RuntimeError(f"Run {run_id} is not executable from status {run.status}")

        self.workspace.update_run(run.run_id, "running")
        self.workspace.add_event(run.run_id, "run.running", {})
        self._add_activity(
            run.run_id,
            "activity.started",
            stage="planning",
            message="我已收到这轮输入，先判断它如何更新当前 Idea Plan。",
        )

        graph = self._build_graph()
        history = [
            message
            for message in self.workspace.list_messages(run.thread_id)
            if message.run_id != run_id
        ]
        artifact_context = _build_artifact_context(
            self.workspace,
            self.artifact_manager,
            run.thread_id,
            self.config.context_compaction,
            self.provider_profile.model,
            self.provider_profile.max_output_tokens,
            latest_input=run.input_idea,
        )
        draft_history_context = _build_history_context(
            history,
            latest_input=run.input_idea,
            compaction_config=self.config.context_compaction,
            model=self.provider_profile.model,
            max_output_tokens=self.provider_profile.max_output_tokens,
            artifact_context=artifact_context,
        )
        persistent_summary: ConversationSummary | None = None
        if draft_history_context["compacted"]:
            persistent_summary = _build_conversation_summary(
                thread_id=run.thread_id,
                history=history,
                history_context=draft_history_context,
                existing=self.memory_manager.read_conversation_summary(run.thread_id),
            )
            persistent_summary = self._maybe_refine_conversation_summary(
                run.run_id,
                persistent_summary,
                draft_history_context,
            )
            persistent_summary = self.memory_manager.write_conversation_summary(persistent_summary)
            self.workspace.add_event(
                run.run_id,
                "memory.summary.updated",
                {
                    "summary_id": persistent_summary.summary_id,
                    "thread_id": persistent_summary.thread_id,
                    "covered_message_count": persistent_summary.covered_message_count,
                    "covered_until_ordinal": persistent_summary.covered_until_ordinal,
                    "summary_source": persistent_summary.summary_source,
                    "provider": persistent_summary.provider,
                    "model": persistent_summary.model,
                    "path": persistent_summary.markdown_path,
                    "metadata_path": persistent_summary.metadata_path,
                },
            )
        else:
            persistent_summary = self.memory_manager.read_conversation_summary(run.thread_id)

        history_context = _build_history_context(
            history,
            persistent_summary=persistent_summary,
            latest_input=run.input_idea,
            compaction_config=self.config.context_compaction,
            model=self.provider_profile.model,
            max_output_tokens=self.provider_profile.max_output_tokens,
            artifact_context=artifact_context,
        )
        self.workspace.add_event(
            run.run_id,
            "context.compacted",
            {
                "compacted": history_context["compacted"],
                "total_message_count": history_context["total_message_count"],
                "older_message_count": history_context["older_message_count"],
                "recent_message_count": history_context["recent_message_count"],
                "important_message_count": history_context["important_message_count"],
                "source_refs": history_context["source_refs"],
                "artifact_source_refs": history_context["artifact_source_refs"],
                "important_source_refs": history_context["important_source_refs"],
                "excluded_context_summary": history_context["excluded_context_summary"],
                "compact_reason": history_context["compact_reason"],
                "context_focus": history_context["context_focus"],
                "estimated_history_tokens": history_context["estimated_history_tokens"],
                "history_token_budget": history_context["history_token_budget"],
                "compact_threshold_tokens": history_context["compact_threshold_tokens"],
                "context_window_tokens": history_context["context_window_tokens"],
                "recent_token_budget": history_context["recent_token_budget"],
                "important_token_budget": history_context["important_token_budget"],
                "summary_token_budget": history_context["summary_token_budget"],
                "artifact_context_tokens": history_context["artifact_context_tokens"],
                "artifact_token_budget": history_context["artifact_token_budget"],
                "persistent_summary_id": history_context["persistent_summary_id"],
                "persistent_summary_path": history_context["persistent_summary_path"],
                "persistent_summary_covered_until_ordinal": (
                    history_context["persistent_summary_covered_until_ordinal"]
                ),
            },
        )
        if history_context["compacted"]:
            self._add_activity(
                run.run_id,
                "activity.completed",
                stage="context",
                message=(
                    "历史对话已智能 compact：按 token 预算保留最近原文和高价值旧片段，"
                    "长期摘要写入 memory，完整记录仍在本地 trace。"
                ),
                total_message_count=history_context["total_message_count"],
                older_message_count=history_context["older_message_count"],
                recent_message_count=history_context["recent_message_count"],
                important_message_count=history_context["important_message_count"],
                context_focus=history_context["context_focus"],
                compact_reason=history_context["compact_reason"],
            )

        initial_messages = _build_initial_messages(run.input_idea, history_context)
        initial_state: IdeaPlanState = {
            "idea": run.input_idea,
            "run_id": run.run_id,
            "thread_id": run.thread_id,
            "messages": initial_messages,
            "iteration": 0,
            "tool_calls": [],
            "history_context": history_context,
        }

        try:
            result = graph.invoke(initial_state)
            self._raise_if_cancelled(run.run_id)
            artifact_id = result["artifact_id"]
            completed = self.workspace.update_run(run.run_id, "completed", artifact_id=artifact_id)
            self.workspace.add_event(
                run.run_id,
                "run.completed",
                {"artifact_id": artifact_id, "trace_id": result["trace_id"]},
            )
            metadata = self.workspace.get_artifact_metadata(artifact_id)
            draft = result["draft"]
            return CreateIdeaPlanRunResponse(run=completed, artifact=metadata, draft=draft)
        except RunCancelled as exc:
            if self.workspace.get_run(run.run_id).status != "cancelled":
                self.workspace.update_run(run.run_id, "cancelled", error=str(exc))
                self.workspace.add_event(run.run_id, "run.cancelled", {"reason": str(exc)})
            raise
        except Exception as exc:
            if self.workspace.get_run(run.run_id).status == "cancelled":
                raise RunCancelled("Run cancelled by user") from exc
            failed = self.workspace.update_run(run.run_id, "failed", error=str(exc))
            self.workspace.add_event(run.run_id, "run.failed", {"error": str(exc)})
            raise RuntimeError(f"Idea plan run failed: {failed.run_id}") from exc

    def run(self, idea: str, thread_id: str | None = None) -> CreateIdeaPlanRunResponse:
        run = self.create_run(idea, thread_id)
        return self.execute_run(run.run_id)

    def _build_graph(self) -> Any:
        graph = StateGraph(IdeaPlanState)
        graph.add_node("agent", self._agent_node)
        graph.add_node("tools", self._tools_node)
        graph.add_node("finalize", self._finalize_node)
        graph.set_entry_point("agent")
        graph.add_conditional_edges(
            "agent",
            self._route_after_agent,
            {"tools": "tools", "finalize": "finalize"},
        )
        graph.add_edge("tools", "agent")
        graph.add_edge("finalize", END)
        return graph.compile()

    # ------------------------------------------------------------------
    # Agent node
    # ------------------------------------------------------------------

    def _agent_node(self, state: IdeaPlanState) -> IdeaPlanState:
        run_id = state["run_id"]
        iteration = state["iteration"]

        if iteration >= self.max_iterations:
            return state

        self._raise_if_cancelled(run_id)

        self.workspace.add_event(
            run_id,
            "agent.thinking",
            {"iteration": iteration},
        )
        self._add_activity(
            run_id,
            "activity.updated",
            stage="planning",
            message=(
                "我在整理上下文、近邻文献需求和下一步动作。"
                if iteration == 0
                else "我在结合工具观察结果更新诊断。"
            ),
            iteration=iteration,
        )

        messages = state["messages"]
        tools = self.tool_registry.get_all_definitions()
        provider_request = self.provider.build_agent_request(messages, tools)

        self.workspace.add_event(
            run_id,
            "provider.requested",
            {
                "provider": provider_request.provider,
                "model": provider_request.model,
                "profile": provider_request.profile,
                "request_id": provider_request.request_id,
                "live": provider_request.provider != "mock",
                "iteration": iteration,
                "reasoning_effort": self.provider_profile.reasoning_effort,
                "reasoning_summary": self.provider_profile.reasoning_summary,
            },
        )
        cached_response = self.cache_manager.get_provider_response(provider_request)
        cache_hit = cached_response is not None
        if cached_response is not None:
            provider_response = cached_response.model_copy(
                update={
                    "request_id": provider_request.request_id,
                    "response_id": cached_response.response_id,
                    "cached": True,
                }
            )
            self.workspace.add_event(
                run_id,
                "cache.hit",
                {
                    "cache_type": "provider_response",
                    "provider": provider_request.provider,
                    "model": provider_request.model,
                    "profile": provider_request.profile,
                    "cached_tokens": provider_response.usage.get("cache_read_tokens", 0),
                },
            )
            self._add_activity(
                run_id,
                "activity.completed",
                stage="thinking",
                message="命中本地 app cache，我复用上一轮相同输入下的模型结果。",
                provider=provider_request.provider,
                model=provider_request.model,
            )
        else:
            self._add_activity(
                run_id,
                "activity.started",
                stage="thinking",
                message="我正在让 planner 生成诊断或决定是否调用检索工具。",
                provider=provider_request.provider,
                model=provider_request.model,
            )
            provider_response = self._generate_agent_response(
                run_id,
                provider_request,
                tools,
            )
            self.cache_manager.store_provider_response(provider_request, provider_response)
            self.workspace.add_event(
                run_id,
                "cache.stored",
                {
                    "cache_type": "provider_response",
                    "provider": provider_request.provider,
                    "model": provider_request.model,
                    "profile": provider_request.profile,
                },
            )
            self._add_activity(
                run_id,
                "activity.completed",
                stage="thinking",
                message="planner 已返回结果，我开始检查是否需要工具调用。",
                provider=provider_response.provider,
                model=provider_response.model,
            )
        self._raise_if_cancelled(run_id)

        output = provider_response.output
        content = output.get("content")
        reasoning_content = output.get("reasoning_content")
        tool_calls = output.get("tool_calls", [])
        finish_reason = output.get("finish_reason", "stop")

        # OpenAI format assistant message with tool_calls
        assistant_msg: dict[str, Any] = {
            "role": "assistant",
            "content": content,
        }
        if reasoning_content:
            assistant_msg["reasoning_content"] = reasoning_content
        if tool_calls:
            assistant_msg["tool_calls"] = [
                {
                    "id": tc["call_id"],
                    "type": "function",
                    "function": {"name": tc["name"], "arguments": json.dumps(tc["arguments"])},
                }
                for tc in tool_calls
            ]

        new_messages: list[dict[str, Any]] = [*messages, assistant_msg]

        self.workspace.add_event(
            run_id,
            "provider.responded",
            {
                "provider": provider_response.provider,
                "model": provider_response.model,
                "response_id": provider_response.response_id,
                "has_tool_calls": bool(tool_calls),
                "tool_count": len(tool_calls),
                "finish_reason": finish_reason,
                "usage": provider_response.usage,
                "cached": provider_response.cached,
                "cache_hit": cache_hit,
            },
        )

        if tool_calls:
            self.workspace.add_event(
                run_id,
                "decision.made",
                {"decision": "call_tools", "tool_names": [tc["name"] for tc in tool_calls]},
            )
            self._add_activity(
                run_id,
                "activity.updated",
                stage="deciding",
                message=_tool_decision_message(tool_calls),
                tool_names=[tc["name"] for tc in tool_calls],
            )
        else:
            self._add_activity(
                run_id,
                "activity.completed",
                stage="deciding",
                message="这一轮不需要继续调用工具，准备收束成五字段诊断。",
                finish_reason=finish_reason,
            )

        return {
            **state,
            "messages": new_messages,
            "tool_calls": tool_calls,
            "iteration": iteration + 1,
            "provider_response": provider_response.model_dump(mode="json"),
        }

    def _route_after_agent(self, state: IdeaPlanState) -> str:
        if state["iteration"] >= self.max_iterations:
            return "finalize"
        if state.get("tool_calls"):
            return "tools"
        return "finalize"

    # ------------------------------------------------------------------
    # Tools node
    # ------------------------------------------------------------------

    def _tools_node(self, state: IdeaPlanState) -> IdeaPlanState:
        run_id = state["run_id"]
        thread_id = state["thread_id"]
        tool_calls = state["tool_calls"]
        new_messages: list[dict[str, Any]] = list(state["messages"])

        for tc in tool_calls:
            call_id = tc["call_id"]
            tool_message = _tool_start_message(tc["name"], tc["arguments"])
            self._add_activity(
                run_id,
                "activity.started",
                stage="searching" if tc["name"] in {"paper_search", "web_search"} else "acting",
                message=tool_message,
                tool_name=tc["name"],
                tool_call_id=call_id,
                arguments=tc["arguments"],
            )
            self.workspace.add_event(
                run_id,
                "action.started",
                {
                    "tool_name": tc["name"],
                    "tool_call_id": call_id,
                    "arguments": tc["arguments"],
                },
            )

            result = self.tool_registry.execute(tc["name"], tc["arguments"])
            result_text = json.dumps(result, ensure_ascii=False)
            result_summary = _tool_result_summary(tc["name"], result)
            if tc["name"] == "paper_search":
                try:
                    search_response = SearchResponse.model_validate(result)
                    artifact, _evidence = self.artifact_manager.write_paper_search_evidence(
                        run_id,
                        search_response,
                    )
                    self.workspace.add_event(
                        run_id,
                        "paper_search.evidence.created",
                        {
                            "artifact_id": artifact.artifact_id,
                            "artifact_type": artifact.artifact_type,
                            "path": artifact.path,
                            "metadata_path": artifact.metadata_path,
                            "query": search_response.query,
                            "result_count": len(search_response.results),
                        },
                    )
                except Exception as exc:
                    self.workspace.add_event(
                        run_id,
                        "paper_search.evidence.failed",
                        {"error": str(exc)},
                    )

            self.workspace.add_message(
                thread_id, "tool",
                content=result_text,
                run_id=run_id,
                tool_call_id=call_id,
                tool_name=tc["name"],
                tool_args=tc["arguments"],
            )

            # OpenAI format: tool result as role=tool message
            new_messages.append({
                "role": "tool",
                "tool_call_id": call_id,
                "name": tc["name"],
                "content": result_text,
            })

            result_error = result.get("error")
            result_items = result.get("results")
            has_results = isinstance(result_items, list) and len(result_items) > 0
            is_error = bool(result_error) and not has_results
            self.workspace.add_event(
                run_id,
                "observation.summary",
                {
                    "tool_name": tc["name"],
                    "tool_call_id": call_id,
                    "error": is_error,
                    "partial_error": bool(result_error) and has_results,
                    "result_length": len(result_text),
                    **result_summary,
                },
            )
            self._add_activity(
                run_id,
                "activity.completed",
                stage="observing",
                message=_tool_observation_message(tc["name"], result_summary, is_error),
                tool_name=tc["name"],
                tool_call_id=call_id,
                **result_summary,
            )

        return {**state, "messages": new_messages, "tool_calls": []}

    # ------------------------------------------------------------------
    # Finalize node
    # ------------------------------------------------------------------

    def _finalize_node(self, state: IdeaPlanState) -> IdeaPlanState:
        run_id = state["run_id"]
        run = self.workspace.get_run(run_id)
        idea = state["idea"]

        self._raise_if_cancelled(run_id)

        # Extract diagnosis from the last assistant text content
        last_content = None
        for msg in reversed(state["messages"]):
            if msg.get("role") == "assistant" and msg.get("content"):
                last_content = msg["content"]
                break

        try:
            diagnosis = _diagnosis_from_text(last_content or "")
        except Exception:
            diagnosis = self._synthesize_final_diagnosis(state, idea)

        history = [
            message
            for message in self.workspace.list_messages(run.thread_id)
            if message.run_id != run_id
        ]

        history_context = state.get("history_context", {})
        context = self.context_builder.build_for_idea(
            idea,
            relevant_artifacts=list(history_context.get("artifact_source_refs", [])),
            source_refs=list(history_context.get("source_refs", [])),
            excluded_context_summary=str(
                history_context.get("excluded_context_summary")
                or "No prior context exclusions recorded."
            ),
        )
        self.workspace.add_event(
            run_id,
            "context.built",
            {
                "context_id": context.context_id,
                "source_refs": context.source_refs,
                "excluded_context_summary": context.excluded_context_summary,
            },
        )
        self._add_activity(
            run_id,
            "activity.completed",
            stage="context",
            message="已构造本轮最小上下文包，准备写入会话诊断。",
            context_id=context.context_id,
        )
        self._raise_if_cancelled(run_id)

        assistant_content = _assistant_summary(
            diagnosis,
            is_session_start=not history,
            language=_language_from_text(idea),
        )
        self._add_activity(
            run_id,
            "activity.started",
            stage="answering",
            message="我开始把诊断流式输出给你。",
        )
        self.workspace.add_event(
            run_id,
            "assistant.reset",
            {"reason": "final_answer"},
        )
        self._emit_assistant_stream(run_id, assistant_content)
        self._add_activity(
            run_id,
            "activity.completed",
            stage="answering",
            message="五字段诊断已经输出完毕，接下来写入 artifact 和 trace。",
        )
        self._raise_if_cancelled(run_id)

        self.workspace.add_message(
            run.thread_id,
            "assistant",
            assistant_content,
            run_id,
        )
        self._raise_if_cancelled(run_id)

        generated_title = self._maybe_generate_thread_title(
            run_id,
            run.thread_id,
            idea,
            diagnosis,
            history,
        )
        previous_artifact = self.workspace.latest_artifact_for_thread(run.thread_id)

        provider_response = state.get("provider_response", {})
        trace = self.trace_recorder.record(
            run_id,
            "idea_plan_agent",
            {
                "context": context.model_dump(mode="json"),
                "history_context": state.get("history_context", {}),
                "provider_response": provider_response,
                "thread_messages": [
                    message.model_dump(mode="json")
                    for message in self.workspace.list_messages(run.thread_id)
                ],
                "agent_iterations": state.get("iteration", 0),
                "provider_profile": self.provider_profile.model_dump(mode="json"),
                "generated_thread_title": generated_title,
                "decision": (
                    "update ResearchIdeaPlanDraft session artifact"
                    if previous_artifact
                    else "create ResearchIdeaPlanDraft artifact"
                ),
            },
        )
        self.workspace.add_event(
            run_id,
            "trace.recorded",
            {"trace_id": trace.trace_id, "trace_type": trace.trace_type, "path": trace.path},
        )
        self._raise_if_cancelled(run_id)

        trace_refs = [*(previous_artifact.trace_refs if previous_artifact else []), trace.trace_id]

        artifact, draft = self.artifact_manager.write_research_idea_draft(
            run_id=run_id,
            diagnosis=diagnosis,
            context=context,
            trace_refs=trace_refs,
            artifact_id=previous_artifact.artifact_id if previous_artifact else None,
        )
        artifact_event_type = "artifact.updated" if previous_artifact else "artifact.created"
        self.workspace.add_event(
            run_id,
            artifact_event_type,
            {
                "artifact_id": artifact.artifact_id,
                "artifact_type": artifact.artifact_type,
                "path": artifact.path,
                "metadata_path": artifact.metadata_path,
            },
        )
        self._refresh_memory_map(run_id)

        return {
            **state,
            "context": context.model_dump(mode="json"),
            "trace_id": trace.trace_id,
            "artifact_id": artifact.artifact_id,
            "draft": draft.model_dump(mode="json"),
            "diagnosis": diagnosis.model_dump(mode="json"),
        }

    def _generate_agent_response(
        self,
        run_id: str,
        provider_request: Any,
        tools: list[dict[str, Any]],
    ) -> ProviderResponse:
        stream = self.provider.stream_agent_response(provider_request, tools)
        if stream is None:
            return self.provider.generate_agent_response(provider_request, tools)

        self.workspace.add_event(
            run_id,
            "provider.stream.started",
            {
                "provider": provider_request.provider,
                "model": provider_request.model,
                "profile": provider_request.profile,
            },
        )
        self._add_activity(
            run_id,
            "activity.updated",
            stage="thinking",
            message="planner 已进入流式输出；我会实时展示可见内容，隐藏推理链只保留为内部记录。",
            provider=provider_request.provider,
            model=provider_request.model,
        )

        chunks = 0
        reasoning_chunks = 0
        final_response: ProviderResponse | None = None
        try:
            for chunk in stream:
                self._raise_if_cancelled(run_id)
                chunk_type = chunk.get("type")
                if chunk_type == "content_delta":
                    delta = str(chunk.get("delta") or "")
                    if not delta:
                        continue
                    self.workspace.add_event(
                        run_id,
                        "assistant.delta",
                        {
                            "index": chunks,
                            "delta": delta,
                            "source": "provider_stream",
                        },
                    )
                    chunks += 1
                    continue
                if chunk_type == "reasoning_delta":
                    reasoning_chunks += 1
                    continue
                if chunk_type == "tool_call_delta":
                    self.workspace.add_event(
                        run_id,
                        "provider.tool_call.delta",
                        {
                            "tool_count": len(chunk.get("tool_calls") or []),
                            "source": "provider_stream",
                        },
                    )
                    continue
                if chunk_type == "completed":
                    response = chunk.get("response")
                    if isinstance(response, ProviderResponse):
                        final_response = response
        except ProviderError as exc:
            self.workspace.add_event(
                run_id,
                "provider.stream.fallback",
                {
                    "provider": provider_request.provider,
                    "model": provider_request.model,
                    "error": str(exc),
                },
            )
            self._add_activity(
                run_id,
                "activity.updated",
                stage="thinking",
                message="planner 流式调用失败，我切换到非流式请求完成本轮诊断。",
                provider=provider_request.provider,
                model=provider_request.model,
            )
            return self.provider.generate_agent_response(provider_request, tools)

        if final_response is None:
            raise ProviderError("Provider stream ended without a completed response.")

        if chunks:
            self.workspace.add_event(
                run_id,
                "assistant.completed",
                {
                    "chunks": chunks,
                    "source": "provider_stream",
                    "reasoning_chunks_hidden": reasoning_chunks,
                },
            )
        self.workspace.add_event(
            run_id,
            "provider.stream.completed",
            {
                "provider": final_response.provider,
                "model": final_response.model,
                "response_id": final_response.response_id,
                "chunks": chunks,
                "reasoning_chunks_hidden": reasoning_chunks,
            },
        )
        return final_response

    def _synthesize_final_diagnosis(self, state: IdeaPlanState, idea: str) -> Diagnosis:
        run_id = state["run_id"]
        self._add_activity(
            run_id,
            "activity.updated",
            stage="synthesizing",
            message="工具检索已结束，我正在强制收束为五字段诊断。",
        )
        messages = _build_final_synthesis_messages(
            idea=idea,
            messages=state["messages"],
            history_context=state.get("history_context", {}),
        )
        request = self.provider.build_agent_request(messages, tools=[])
        self.workspace.add_event(
            run_id,
            "provider.requested",
            {
                "provider": request.provider,
                "model": request.model,
                "profile": request.profile,
                "request_id": request.request_id,
                "live": request.provider != "mock",
                "phase": "final_synthesis",
            },
        )
        try:
            cached_response = self.cache_manager.get_provider_response(request)
            response = cached_response
            if response is None:
                response = self.provider.generate_agent_response(request, tools=[])
                self.cache_manager.store_provider_response(request, response)
            else:
                response = response.model_copy(
                    update={
                        "request_id": request.request_id,
                        "response_id": response.response_id,
                        "cached": True,
                    }
                )
            self.workspace.add_event(
                run_id,
                "provider.responded",
                {
                    "provider": response.provider,
                    "model": response.model,
                    "response_id": response.response_id,
                    "phase": "final_synthesis",
                    "usage": response.usage,
                    "cached": response.cached,
                },
            )
            content = str(response.output.get("content") or "")
            diagnosis = _diagnosis_from_text(content)
            self._add_activity(
                run_id,
                "activity.completed",
                stage="synthesizing",
                message="已根据工具观察结果完成最终诊断收束。",
            )
            return diagnosis
        except Exception as exc:
            self.workspace.add_event(
                run_id,
                "final_synthesis.failed",
                {"error": str(exc)},
            )
            self._add_activity(
                run_id,
                "activity.completed",
                stage="synthesizing",
                message="最终诊断收束失败，将使用保底诊断并提示重新运行。",
            )
            return _fallback_diagnosis(idea)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _diagnosis_from_response(self, response: ProviderResponse) -> Diagnosis:
        return Diagnosis.model_validate(response.output["diagnosis"])

    def _raise_if_cancelled(self, run_id: str) -> None:
        if self.workspace.get_run(run_id).status == "cancelled":
            raise RunCancelled("Run cancelled by user")

    def _add_activity(
        self,
        run_id: str,
        event_type: str,
        *,
        stage: str,
        message: str,
        **payload: Any,
    ) -> None:
        self.workspace.add_event(
            run_id,
            event_type,
            {"stage": stage, "message": message, **payload},
        )

    def _emit_assistant_stream(self, run_id: str, content: str) -> None:
        chunks = _stream_chunks(content)
        for index, chunk in enumerate(chunks):
            self._raise_if_cancelled(run_id)
            self.workspace.add_event(
                run_id,
                "assistant.delta",
                {"index": index, "delta": chunk},
            )
            if len(chunks) > 1:
                time.sleep(0.003)
        self.workspace.add_event(
            run_id,
            "assistant.completed",
            {"chunks": len(chunks), "length": len(content)},
        )

    def _refresh_memory_map(self, run_id: str) -> None:
        memory_map = self.memory_manager.rebuild_project_memory_map()
        self.workspace.add_event(
            run_id,
            "memory.map.updated",
            {
                "path": memory_map.markdown_path,
                "metadata_path": memory_map.metadata_path,
                "record_count": memory_map.record_count,
                "thread_count": memory_map.thread_count,
            },
        )

    def _maybe_refine_conversation_summary(
        self,
        run_id: str,
        summary: ConversationSummary,
        history_context: HistoryContextPacket,
    ) -> ConversationSummary:
        extractor_profile = self.config.profile("extractor")
        if extractor_profile.provider == "mock":
            return summary
        self.workspace.add_event(
            run_id,
            "memory.summary.refine_requested",
            {
                "profile": extractor_profile.profile,
                "provider": extractor_profile.provider,
                "model": extractor_profile.model,
                "summary_id": summary.summary_id,
            },
        )
        try:
            provider = create_idea_diagnosis_provider(extractor_profile, self.config.env)
            request = provider.build_agent_request(
                [
                    {
                        "role": "system",
                        "content": _conversation_summary_system_prompt(),
                    },
                    {
                        "role": "user",
                        "content": _conversation_summary_user_prompt(summary, history_context),
                    },
                ],
                [],
            )
            response = provider.generate_agent_response(request, [])
            content = str(response.output.get("content") or "").strip()
            refined = _clean_summary_text(content)
            if not refined:
                raise RuntimeError("Extractor returned an empty conversation summary.")
            self.workspace.add_event(
                run_id,
                "memory.summary.refined",
                {
                    "summary_id": summary.summary_id,
                    "provider": response.provider,
                    "model": response.model,
                    "usage": response.usage,
                },
            )
            return summary.model_copy(
                update={
                    "summary_source": "llm",
                    "provider": response.provider,
                    "model": response.model,
                    "summary_text": refined,
                    "updated_at": utc_now(),
                }
            )
        except Exception as exc:
            self.workspace.add_event(
                run_id,
                "memory.summary.refine_failed",
                {
                    "summary_id": summary.summary_id,
                    "provider": extractor_profile.provider,
                    "model": extractor_profile.model,
                    "error": str(exc),
                },
            )
            return summary

    def _maybe_generate_thread_title(
        self,
        run_id: str,
        thread_id: str,
        idea: str,
        diagnosis: Diagnosis,
        history: list[Any],
    ) -> str | None:
        thread = self.workspace.get_thread(thread_id)
        if thread.name or history:
            return None
        self.workspace.add_event(run_id, "thread.title.requested", {"thread_id": thread_id})
        try:
            title = self.provider.generate_thread_title(idea, diagnosis)
            source = "provider"
        except Exception:
            title = _fallback_title(idea)
            source = "fallback"
        if _is_placeholder_title(title):
            title = _fallback_title(idea)
            source = f"{source}+fallback"
        title = self._rename_thread_uniquely(thread_id, title)
        self.workspace.add_event(
            run_id,
            "thread.title.generated",
            {"thread_id": thread_id, "title": title, "source": source},
        )
        return title

    def _rename_thread_uniquely(self, thread_id: str, title: str) -> str:
        normalized = title.strip() or _fallback_title(title)
        candidates = [normalized, *[f"{normalized} {index}" for index in range(2, 10)]]
        for candidate in candidates:
            try:
                self.workspace.rename_thread(thread_id, candidate)
                return candidate
            except ValueError:
                continue
        fallback = f"{normalized} {thread_id[-4:]}"
        self.workspace.rename_thread(thread_id, fallback)
        return fallback

    def auto_rename_thread(self, thread_id: str) -> str:
        self.workspace.get_thread(thread_id)
        messages = [
            message
            for message in self.workspace.list_messages(thread_id)
            if message.role in {"user", "assistant"} and message.content.strip()
        ]
        latest_user = next((message for message in reversed(messages) if message.role == "user"), None)
        latest_assistant = next(
            (message for message in reversed(messages) if message.role == "assistant"),
            None,
        )
        idea = latest_user.content if latest_user is not None else ""
        try:
            diagnosis = (
                _diagnosis_from_text(latest_assistant.content)
                if latest_assistant is not None
                else _fallback_diagnosis(idea)
            )
        except Exception:
            diagnosis = _fallback_diagnosis(idea)
        try:
            title = self.provider.generate_thread_title(idea, diagnosis)
        except Exception:
            title = _fallback_title_from_messages(messages)
        if _is_placeholder_title(title):
            title = _fallback_title_from_messages(messages)
        return self._rename_thread_uniquely(thread_id, title)


# ------------------------------------------------------------------
# Module-level helpers
# ------------------------------------------------------------------

COMPACT_RECENT_MESSAGE_LIMIT = 8
COMPACT_SUMMARY_CHAR_LIMIT = 3600
COMPACT_RECENT_CHAR_LIMIT = 6000
COMPACT_MESSAGE_CHAR_LIMIT = 900
DEFAULT_CONTEXT_WINDOW_TOKENS = 16_000
MODEL_CONTEXT_WINDOW_HINTS: tuple[tuple[str, int], ...] = (
    ("gpt-5", 128_000),
    ("gpt-4.1", 1_000_000),
    ("gpt-4o", 128_000),
    ("claude", 200_000),
    ("deepseek", 64_000),
)
CONTEXT_FOCUS_KEYWORDS: dict[str, tuple[str, ...]] = {
    "literature": (
        "论文",
        "文献",
        "paper",
        "arxiv",
        "preprint",
        "openreview",
        "related work",
        "novelty",
        "最新论文",
        "最新文献",
        "最新预印本",
        "检索",
    ),
    "experiment": (
        "实验",
        "baseline",
        "metric",
        "ablation",
        "benchmark",
        "数据集",
        "评测",
        "human evaluation",
    ),
    "result_analysis": (
        "结果",
        "分析",
        "显著性",
        "error analysis",
        "失败案例",
        "support",
        "falsify",
        "weaken",
    ),
    "writing": (
        "写作",
        "paper",
        "abstract",
        "introduction",
        "related work",
        "rebuttal",
        "camera-ready",
        "投稿",
    ),
    "execution": (
        "代码",
        "实现",
        "bug",
        "报错",
        "测试",
        "api",
        "tui",
        "fastapi",
        "typescript",
        "python",
    ),
    "memory": (
        "compact",
        "上下文",
        "记忆",
        "memory",
        "resume",
        "session",
        "历史",
        "trace",
    ),
    "idea_plan": (
        "idea",
        "计划",
        "plan",
        "顶会",
        "创新",
        "算法",
        "机制",
        "方向",
        "claim",
    ),
}
IMPORTANT_KEYWORDS = (
    "必须",
    "不要",
    "不能",
    "优先",
    "约束",
    "决定",
    "确认",
    "纠正",
    "不是",
    "应该",
    "保留",
    "冻结",
    "frozen",
    "advance",
    "reject",
    "revise",
    "claim",
    "baseline",
    "ablation",
    "novelty",
    "顶会",
    "算法",
    "安全",
)
SENSITIVE_ASSIGNMENT_RE = re.compile(
    r"(?i)\b(api[_-]?key|token|secret|password)\s*[:=]\s*([^\s,;]+)"
)
SENSITIVE_TOKEN_RE = re.compile(
    r"(?i)\b(sk-[a-z0-9_-]{12,}|sk-ant-[a-z0-9_-]{12,}|[a-z0-9_-]{24,}\.[a-z0-9_-]{12,}\.[a-z0-9_-]{12,})\b"
)


def _model_context_window(model: str, config: ContextCompactionConfig) -> int:
    if config.context_window_tokens:
        return config.context_window_tokens
    normalized = model.lower()
    for marker, window in MODEL_CONTEXT_WINDOW_HINTS:
        if marker in normalized:
            return window
    return DEFAULT_CONTEXT_WINDOW_TOKENS


def _history_token_budget(
    config: ContextCompactionConfig,
    model: str,
    max_output_tokens: int,
) -> int:
    model_window = _model_context_window(model, config)
    available = (
        model_window
        - max_output_tokens
        - config.response_token_reserve
        - config.system_tool_token_reserve
    )
    return max(64, min(config.max_history_tokens, available))


def _compact_threshold_tokens(config: ContextCompactionConfig, history_token_budget: int) -> int:
    return max(1, int(history_token_budget * config.compact_trigger_ratio))


def _recent_token_budget(
    config: ContextCompactionConfig,
    history_token_budget: int,
    recent_char_limit: int | None,
) -> int:
    if recent_char_limit is not None:
        return max(1, int(recent_char_limit / max(1.0, config.chars_per_token)))
    return max(128, int(history_token_budget * config.recent_token_ratio))


def _artifact_token_budget(config: ContextCompactionConfig, history_token_budget: int) -> int:
    ratio_budget = max(400, int(history_token_budget * config.artifact_token_ratio))
    return max(400, min(config.artifact_max_tokens, ratio_budget))


def _prepend_artifact_context(history_prompt: str, artifact_context_text: str) -> str:
    if not artifact_context_text.strip():
        return history_prompt
    return (
        "Artifact memory context (highest priority, source-referenced):\n"
        f"{artifact_context_text.strip()}\n\n"
        f"{history_prompt}"
    )


def _build_artifact_context(
    workspace: ProjectWorkspace,
    artifact_manager: ArtifactManager,
    thread_id: str,
    compaction_config: ContextCompactionConfig,
    model: str,
    max_output_tokens: int,
    latest_input: str = "",
) -> ArtifactContextPacket:
    history_budget = _history_token_budget(compaction_config, model, max_output_tokens)
    token_budget = _artifact_token_budget(compaction_config, history_budget)
    chars_per_token = max(1.0, compaction_config.chars_per_token)
    char_budget = max(600, int(token_budget * chars_per_token))
    lines: list[str] = []
    source_refs: list[str] = []

    plan_metadata = workspace.latest_plan_artifact_for_thread(thread_id)
    if plan_metadata is not None:
        source_refs.append(f"artifact:{plan_metadata.artifact_id}")
        try:
            if plan_metadata.artifact_type == "ResearchIdeaPlan":
                _, plan = artifact_manager.read_research_idea_plan(plan_metadata.artifact_id)
                diagnosis = plan.diagnosis
                status = plan.status
                title = plan.title
            else:
                _, draft = artifact_manager.read_research_idea_draft(plan_metadata.artifact_id)
                diagnosis = draft.diagnosis
                status = "draft"
                title = draft.title
            lines.extend(
                [
                    "## Current Research Idea Artifact",
                    f"- Artifact: `{plan_metadata.artifact_id}` ({plan_metadata.artifact_type}, {status})",
                    f"- Path: `{plan_metadata.path}`",
                    f"- Title: {title}",
                    f"- Problem: {_truncate_one_line(diagnosis.problem, 420)}",
                    f"- Gap: {_truncate_one_line(diagnosis.gap, 420)}",
                    "- Candidate Mechanism: "
                    f"{_truncate_one_line(diagnosis.candidate_mechanism, 420)}",
                    "- Main Uncertainty: "
                    f"{_truncate_one_line(diagnosis.main_uncertainty, 420)}",
                    "- Evidence Needed: "
                    + " | ".join(_truncate_one_line(item, 180) for item in diagnosis.evidence_needed[:5]),
                ]
            )
            if diagnosis.clarifying_questions:
                lines.append(
                    "- Clarifying Questions: "
                    + " | ".join(
                        _truncate_one_line(item, 160)
                        for item in diagnosis.clarifying_questions[:4]
                    )
                )
        except Exception as exc:
            lines.extend(
                [
                    "## Current Research Idea Artifact",
                    f"- Artifact: `{plan_metadata.artifact_id}` ({plan_metadata.artifact_type})",
                    f"- Read error: {_truncate_one_line(str(exc), 240)}",
                ]
            )

    review = workspace.latest_idea_review(thread_id)
    if review is not None:
        source_refs.append(f"review:{review['review_id']}")
        lines.extend(
            [
                "",
                "## Latest Idea Review Gate",
                f"- Review: `{review['review_id']}`",
                f"- Decision: `{review['decision']}`",
                f"- Artifact: `{review['artifact_id']}`",
                f"- Created at: `{review['created_at']}`",
                f"- Notes: {_truncate_one_line(str(review.get('notes') or 'None'), 520)}",
            ]
        )

    evidence_limit = max(0, compaction_config.paper_evidence_limit)
    evidence_artifacts = workspace.latest_artifacts_for_thread(
        thread_id,
        "PaperSearchEvidence",
        limit=evidence_limit,
    )
    if evidence_artifacts:
        lines.extend(["", f"## Recent Paper Search Evidence ({len(evidence_artifacts)})"])
    for metadata in evidence_artifacts:
        source_refs.append(f"paper_evidence:{metadata.artifact_id}")
        try:
            _, evidence = artifact_manager.read_paper_search_evidence(metadata.artifact_id)
            response = evidence.search_response
            titles = [
                _truncate_one_line(result.title, 180)
                for result in response.results[:5]
                if result.title
            ]
            lines.extend(
                [
                    f"- Evidence: `{metadata.artifact_id}`",
                    f"  - Query: {evidence.query}",
                    f"  - Source: `{response.source}`; retrieved_at: `{response.retrieved_at}`",
                    f"  - Result count: `{len(response.results)}`",
                    f"  - Error: {_truncate_one_line(str(response.error or 'None'), 240)}",
                    f"  - Top titles: {' | '.join(titles) if titles else 'None'}",
                ]
            )
        except Exception as exc:
            lines.extend(
                [
                    f"- Evidence: `{metadata.artifact_id}`",
                    f"  - Read error: {_truncate_one_line(str(exc), 240)}",
                ]
            )

    memory_query = latest_input.strip()
    if memory_query:
        memory_hits = MemoryManager(workspace).search_memory(
            memory_query,
            thread_id=thread_id,
            limit=6,
        ).results
    else:
        memory_hits = []
    if memory_hits:
        lines.extend(["", f"## Retrieved Memory Records ({len(memory_hits)})"])
    for hit in memory_hits:
        record = hit.record
        source_refs.append(f"memory:{record.record_id}")
        lines.extend(
            [
                f"- Memory: `{record.record_id}` ({record.record_type}, score={hit.score})",
                f"  - Title: {record.title}",
                f"  - Status: `{record.status}`; reason: {hit.reason}",
                f"  - Summary: {_truncate_one_line(record.summary, 520)}",
                f"  - Source refs: {', '.join(record.source_refs[:8]) or 'None'}",
            ]
        )

    open_conflicts = workspace.list_conflict_records(
        thread_id=thread_id,
        status="open",
        limit=5,
    )
    if open_conflicts:
        lines.extend(["", f"## Open Memory Conflicts ({len(open_conflicts)})"])
    for conflict in open_conflicts:
        source_refs.append(f"conflict:{conflict.conflict_id}")
        lines.extend(
            [
                f"- Conflict: `{conflict.conflict_id}` ({conflict.conflict_type})",
                f"  - Summary: {_truncate_one_line(conflict.summary, 520)}",
                f"  - Source refs: {', '.join(conflict.source_refs[:8]) or 'None'}",
            ]
        )

    if not lines:
        return ArtifactContextPacket(
            prompt_text="",
            source_refs=[],
            estimated_tokens=0,
            token_budget=token_budget,
        )

    prompt_text = _truncate_preserving_lines("\n".join(lines), char_budget)
    return ArtifactContextPacket(
        prompt_text=prompt_text,
        source_refs=source_refs,
        estimated_tokens=_estimate_text_tokens(prompt_text, chars_per_token),
        token_budget=token_budget,
    )


def _estimate_messages_chars(messages: list[ThreadMessage]) -> int:
    return sum(len(message.content) for message in messages)


def _estimate_messages_tokens(messages: list[ThreadMessage], chars_per_token: float) -> int:
    return sum(_estimate_message_tokens(message, chars_per_token) for message in messages)


def _estimate_text_tokens(text: str, chars_per_token: float) -> int:
    if not text:
        return 0
    return max(1, int((len(text) + 16) / chars_per_token))


def _estimate_message_tokens(message: ThreadMessage, chars_per_token: float) -> int:
    return max(1, int((len(message.content) + len(message.role) + 16) / chars_per_token))


def _safe_ratio(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return round(numerator / denominator, 4)


def _detect_context_focus(latest_input: str) -> str:
    text = latest_input.lower()
    best_focus = "idea_plan"
    best_score = 0
    for focus, keywords in CONTEXT_FOCUS_KEYWORDS.items():
        score = sum(1 for keyword in keywords if keyword.lower() in text)
        if score > best_score:
            best_score = score
            best_focus = focus
    return best_focus


def _select_important_messages(
    messages: list[ThreadMessage],
    latest_input: str,
    context_focus: str,
    token_budget: int,
    limit: int,
    chars_per_token: float,
    per_message_token_limit: int,
) -> list[ThreadMessage]:
    if not messages or token_budget <= 0 or limit <= 0:
        return []
    scored = [
        (
            _score_message_importance(
                message,
                latest_input=latest_input,
                context_focus=context_focus,
                max_ordinal=messages[-1].ordinal,
            ),
            message,
        )
        for message in messages
    ]
    selected: list[ThreadMessage] = []
    used_tokens = 0
    for score, message in sorted(scored, key=lambda item: (-item[0], -item[1].ordinal)):
        if score < 2.2:
            continue
        message_tokens = min(
            _estimate_message_tokens(message, chars_per_token),
            per_message_token_limit,
        )
        if selected and used_tokens + message_tokens > token_budget:
            continue
        selected.append(message)
        used_tokens += message_tokens
        if len(selected) >= limit:
            break
    return sorted(selected, key=lambda message: message.ordinal)


def _score_message_importance(
    message: ThreadMessage,
    latest_input: str,
    context_focus: str,
    max_ordinal: int,
) -> float:
    content = message.content.lower()
    score = 0.4 if message.role == "assistant" else 0.8
    if max_ordinal > 0:
        score += min(1.2, message.ordinal / max_ordinal)
    score += min(3.0, 0.55 * _keyword_count(content, IMPORTANT_KEYWORDS))
    score += min(2.5, 0.7 * _keyword_count(content, CONTEXT_FOCUS_KEYWORDS[context_focus]))
    score += min(2.0, 0.35 * _latest_input_overlap(content, latest_input))
    if "?" in message.content or "？" in message.content:
        score += 0.8
    if any(marker in message.content for marker in ("Problem:", "Gap:", "问题：", "差距：")):
        score += 1.2
    if "error" in content or "报错" in content or "失败" in content:
        score += 1.0
    return score


def _keyword_count(text: str, keywords: tuple[str, ...]) -> int:
    return sum(1 for keyword in keywords if keyword.lower() in text)


def _latest_input_overlap(content: str, latest_input: str) -> int:
    terms = {
        term
        for term in latest_input.lower().replace("/", " ").replace("_", " ").split()
        if len(term) >= 3
    }
    return sum(1 for term in terms if term in content)


def _compact_reason(
    token_budget_trigger: bool,
    exact_history_message_trigger: bool,
    exact_history_char_trigger: bool,
    estimated_history_tokens: int,
    compact_threshold_tokens: int,
) -> str:
    reasons: list[str] = []
    if token_budget_trigger:
        reasons.append(
            f"history token estimate exceeded compact threshold "
            f"({estimated_history_tokens}/{compact_threshold_tokens})"
        )
    if exact_history_message_trigger:
        reasons.append("explicit recent message window exceeded")
    if exact_history_char_trigger:
        reasons.append("explicit recent character window exceeded")
    return "; ".join(reasons) if reasons else "history compacted by policy"


def _build_history_context(
    history: list[ThreadMessage],
    persistent_summary: ConversationSummary | None = None,
    latest_input: str = "",
    compaction_config: ContextCompactionConfig | None = None,
    model: str = "",
    max_output_tokens: int = 900,
    artifact_context: ArtifactContextPacket | None = None,
    recent_message_limit: int | None = None,
    summary_char_limit: int | None = None,
    recent_char_limit: int | None = None,
) -> HistoryContextPacket:
    config = compaction_config or ContextCompactionConfig()
    chars_per_token = max(1.0, config.chars_per_token)
    context_focus = _detect_context_focus(latest_input)
    context_window_tokens = _model_context_window(model, config)
    history_token_budget = _history_token_budget(config, model, max_output_tokens)
    compact_threshold_tokens = _compact_threshold_tokens(config, history_token_budget)
    recent_token_budget = _recent_token_budget(config, history_token_budget, recent_char_limit)
    important_token_budget = max(1, int(history_token_budget * config.important_token_ratio))
    summary_token_budget = (
        max(1, int(summary_char_limit / chars_per_token))
        if summary_char_limit is not None
        else max(1, int(history_token_budget * config.summary_token_ratio))
    )
    artifact_context_text = artifact_context["prompt_text"] if artifact_context else ""
    artifact_source_refs = artifact_context["source_refs"] if artifact_context else []
    artifact_context_tokens = artifact_context["estimated_tokens"] if artifact_context else 0
    artifact_token_budget = (
        artifact_context["token_budget"]
        if artifact_context
        else _artifact_token_budget(config, history_token_budget)
    )
    max_recent_messages = recent_message_limit or config.max_recent_messages
    min_recent_messages = min(config.min_recent_messages, max_recent_messages)
    per_message_char_limit = max(120, int(config.per_message_token_limit * chars_per_token))

    non_tool_history = [message for message in history if message.role != "tool"]
    estimated_history_tokens = _estimate_messages_tokens(non_tool_history, chars_per_token)
    if not non_tool_history:
        return HistoryContextPacket(
            compacted=False,
            total_message_count=0,
            older_message_count=0,
            recent_message_count=0,
            important_message_count=0,
            prompt_text=_prepend_artifact_context(
                "No previous discussion in this thread.",
                artifact_context_text,
            ),
            source_refs=artifact_source_refs,
            artifact_source_refs=artifact_source_refs,
            important_source_refs=[],
            excluded_context_summary="No previous non-tool messages.",
            compact_reason="no previous non-tool messages",
            context_focus=context_focus,
            estimated_history_tokens=0,
            history_token_budget=history_token_budget,
            compact_threshold_tokens=compact_threshold_tokens,
            context_window_tokens=context_window_tokens,
            recent_token_budget=recent_token_budget,
            important_token_budget=important_token_budget,
            summary_token_budget=summary_token_budget,
            artifact_context_tokens=artifact_context_tokens,
            artifact_token_budget=artifact_token_budget,
            persistent_summary_id=(
                persistent_summary.summary_id if persistent_summary is not None else None
            ),
            persistent_summary_path=(
                persistent_summary.markdown_path if persistent_summary is not None else None
            ),
            persistent_summary_covered_until_ordinal=(
                persistent_summary.covered_until_ordinal
                if persistent_summary is not None
                else None
            ),
        )

    exact_history_message_trigger = (
        recent_message_limit is not None and len(non_tool_history) > recent_message_limit
    )
    exact_history_char_trigger = (
        recent_char_limit is not None
        and _estimate_messages_chars(non_tool_history) > recent_char_limit
    )
    token_budget_trigger = estimated_history_tokens > compact_threshold_tokens
    compacted = bool(
        config.enabled
        and (token_budget_trigger or exact_history_message_trigger or exact_history_char_trigger)
    )
    recent_messages = _select_recent_messages(
        non_tool_history,
        max_recent_messages=max_recent_messages,
        min_recent_messages=min_recent_messages,
        recent_token_budget=recent_token_budget,
        chars_per_token=chars_per_token,
        per_message_token_limit=config.per_message_token_limit,
    )
    message_source_refs = [f"msg:{message.ordinal}" for message in non_tool_history]
    source_refs = [*artifact_source_refs, *message_source_refs]

    if compacted:
        recent_ordinals = {message.ordinal for message in recent_messages}
        older_messages = [
            message for message in non_tool_history if message.ordinal not in recent_ordinals
        ]
        important_messages = _select_important_messages(
            older_messages,
            latest_input=latest_input,
            context_focus=context_focus,
            token_budget=important_token_budget,
            limit=config.important_message_limit,
            chars_per_token=chars_per_token,
            per_message_token_limit=config.per_message_token_limit,
        )
        older_summary = (
            persistent_summary.summary_text
            if persistent_summary is not None
            else _summarize_older_messages(
                older_messages,
                char_limit=int(summary_token_budget * chars_per_token),
            )
        )
        older_header = (
            "Persistent conversation summary"
            if persistent_summary is not None
            else "Older compact summary"
        )
        important_block = ""
        if important_messages:
            important_block = (
                f"\n\nHigh-importance older snippets ({len(important_messages)} messages):\n"
                f"{_format_recent_transcript(important_messages, per_message_char_limit)}"
            )
        compact_reason = _compact_reason(
            token_budget_trigger=token_budget_trigger,
            exact_history_message_trigger=exact_history_message_trigger,
            exact_history_char_trigger=exact_history_char_trigger,
            estimated_history_tokens=estimated_history_tokens,
            compact_threshold_tokens=compact_threshold_tokens,
        )
        history_prompt = (
            "Context compaction policy:\n"
            "- Full transcript is stored locally in SQLite and trace; this packet is a "
            "compressed view for the current LLM call.\n"
            "- Priority 0 is artifact memory: the current ResearchIdeaPlan state, latest "
            "review gate, and paper-search evidence. Layer 2 is a persistent "
            "source-referenced conversation summary. Layer 1 keeps the most recent "
            "messages and high-importance older snippets verbatim for this call.\n"
            f"- Current context focus: {context_focus}.\n"
            f"- Estimated history tokens: {estimated_history_tokens}; history budget: "
            f"{history_token_budget}; compact threshold: {compact_threshold_tokens}; "
            f"recent budget: {recent_token_budget}; important snippet budget: "
            f"{important_token_budget}; summary budget: {summary_token_budget}; "
            f"artifact budget: {artifact_token_budget}.\n"
            "- Treat compacted older history as lossy. Ask the user or inspect stored "
            "artifacts if a missing detail matters.\n\n"
            f"{older_header} ({len(older_messages)} older messages):\n"
            f"{older_summary}"
            f"{important_block}\n\n"
            f"Recent exact transcript ({len(recent_messages)} messages):\n"
            f"{_format_recent_transcript(recent_messages, per_message_char_limit)}"
        )
        prompt_text = _prepend_artifact_context(history_prompt, artifact_context_text)
        excluded = (
            f"{compact_reason}; {len(older_messages)} older non-tool messages were summarized; "
            f"{len(important_messages)} important older messages and "
            f"{len(recent_messages)} recent messages were kept verbatim; "
            f"{len(artifact_source_refs)} artifact memory refs were injected."
        )
    else:
        older_messages = []
        important_messages = []
        recent_messages = non_tool_history
        compact_reason = (
            "context compaction disabled"
            if not config.enabled
            else (
                "history fits token budget "
                f"({estimated_history_tokens}/{compact_threshold_tokens} estimated tokens)"
            )
        )
        history_prompt = (
            f"Recent exact transcript ({len(recent_messages)} messages):\n"
            f"{_format_recent_transcript(recent_messages, per_message_char_limit)}"
        )
        prompt_text = _prepend_artifact_context(history_prompt, artifact_context_text)
        excluded = (
            f"No older messages were summarized; {compact_reason}; "
            f"{len(artifact_source_refs)} artifact memory refs were injected."
        )

    return HistoryContextPacket(
        compacted=compacted,
        total_message_count=len(non_tool_history),
        older_message_count=len(older_messages),
        recent_message_count=len(recent_messages),
        important_message_count=len(important_messages),
        prompt_text=prompt_text,
        source_refs=source_refs,
        artifact_source_refs=artifact_source_refs,
        important_source_refs=[f"msg:{message.ordinal}" for message in important_messages],
        excluded_context_summary=excluded,
        compact_reason=compact_reason,
        context_focus=context_focus,
        estimated_history_tokens=estimated_history_tokens,
        history_token_budget=history_token_budget,
        compact_threshold_tokens=compact_threshold_tokens,
        context_window_tokens=context_window_tokens,
        recent_token_budget=recent_token_budget,
        important_token_budget=important_token_budget,
        summary_token_budget=summary_token_budget,
        artifact_context_tokens=artifact_context_tokens,
        artifact_token_budget=artifact_token_budget,
        persistent_summary_id=(
            persistent_summary.summary_id if persistent_summary is not None else None
        ),
        persistent_summary_path=(
            persistent_summary.markdown_path if persistent_summary is not None else None
        ),
        persistent_summary_covered_until_ordinal=(
            persistent_summary.covered_until_ordinal
            if persistent_summary is not None
            else None
        ),
    )


def build_context_usage(
    workspace: ProjectWorkspace,
    thread_id: str | None = None,
    draft_input: str = "",
) -> ContextUsageResponse:
    config = AgentConfig.load(workspace.project_root)
    profile = config.profile("planner")
    compaction = config.context_compaction
    messages = workspace.list_messages(thread_id) if thread_id else []
    artifact_context = (
        _build_artifact_context(
            workspace,
            ArtifactManager(workspace),
            thread_id,
            compaction,
            profile.model,
            profile.max_output_tokens,
            latest_input=draft_input,
        )
        if thread_id
        else None
    )
    history_context = _build_history_context(
        messages,
        latest_input=draft_input,
        compaction_config=compaction,
        model=profile.model,
        max_output_tokens=profile.max_output_tokens,
        artifact_context=artifact_context,
    )
    chars_per_token = max(1.0, compaction.chars_per_token)
    draft_tokens = _estimate_text_tokens(draft_input, chars_per_token)
    estimated_thread_tokens = history_context["estimated_history_tokens"]
    estimated_artifact_tokens = history_context["artifact_context_tokens"]
    estimated_total_tokens = estimated_thread_tokens + estimated_artifact_tokens + draft_tokens
    context_window_tokens = history_context["context_window_tokens"]
    estimated_context_tokens = min(
        context_window_tokens,
        (
            profile.max_output_tokens
            + compaction.response_token_reserve
            + compaction.system_tool_token_reserve
            + estimated_total_tokens
        ),
    )
    return ContextUsageResponse(
        thread_id=thread_id,
        model=profile.model,
        context_window_tokens=context_window_tokens,
        history_token_budget=history_context["history_token_budget"],
        compact_threshold_tokens=history_context["compact_threshold_tokens"],
        compact_trigger_ratio=compaction.compact_trigger_ratio,
        max_history_tokens=compaction.max_history_tokens,
        estimated_thread_tokens=estimated_thread_tokens,
        estimated_artifact_tokens=estimated_artifact_tokens,
        estimated_draft_tokens=draft_tokens,
        estimated_total_tokens=estimated_total_tokens,
        estimated_context_tokens=estimated_context_tokens,
        usage_ratio=_safe_ratio(estimated_context_tokens, context_window_tokens),
        threshold_ratio=_safe_ratio(
            estimated_thread_tokens,
            history_context["compact_threshold_tokens"],
        ),
        should_compact=history_context["compacted"],
        compact_reason=history_context["compact_reason"],
        context_focus=history_context["context_focus"],
        total_message_count=history_context["total_message_count"],
        recent_message_count=history_context["recent_message_count"],
        older_message_count=history_context["older_message_count"],
        important_message_count=history_context["important_message_count"],
        artifact_source_count=len(history_context["artifact_source_refs"]),
        chars_per_token=chars_per_token,
    )


def _select_recent_messages(
    messages: list[ThreadMessage],
    max_recent_messages: int,
    min_recent_messages: int,
    recent_token_budget: int,
    chars_per_token: float,
    per_message_token_limit: int,
) -> list[ThreadMessage]:
    selected: list[ThreadMessage] = []
    total_tokens = 0
    for message in reversed(messages):
        message_tokens = min(
            _estimate_message_tokens(message, chars_per_token),
            per_message_token_limit,
        )
        if selected and len(selected) >= max_recent_messages:
            break
        if (
            selected
            and len(selected) >= min_recent_messages
            and total_tokens + message_tokens > recent_token_budget
        ):
            break
        selected.append(message)
        total_tokens += message_tokens
    return list(reversed(selected))


def _summarize_older_messages(messages: list[ThreadMessage], char_limit: int) -> str:
    user_goals = _collect_user_goals(messages)
    constraints = _collect_constraints(messages)
    conclusions = _collect_assistant_conclusions(messages)
    open_questions = _collect_open_questions(messages)
    timeline = [
        f"- {message.role.upper()}[{message.ordinal}]: {_truncate_one_line(message.content, 180)}"
        for message in messages[-6:]
    ]
    sections = [
        ("User goals / topic updates", user_goals),
        ("User constraints / preferences", constraints),
        ("Agent conclusions / diagnosis updates", conclusions),
        ("Open questions / unresolved items", open_questions),
        ("Recent older-message timeline", timeline),
    ]
    lines: list[str] = []
    for title, items in sections:
        if not items:
            continue
        lines.append(f"{title}:")
        lines.extend(items[:8])
    if not lines:
        lines.append("- Older messages existed but contained no compactable non-empty text.")
    return _truncate_preserving_lines("\n".join(lines), char_limit)


def _build_conversation_summary(
    thread_id: str,
    history: list[ThreadMessage],
    history_context: HistoryContextPacket,
    existing: ConversationSummary | None = None,
) -> ConversationSummary:
    non_tool_history = [message for message in history if message.role != "tool"]
    older_count = history_context["older_message_count"]
    older_messages = non_tool_history[:older_count]
    summary_text = _summarize_older_messages(
        older_messages,
        char_limit=max(COMPACT_SUMMARY_CHAR_LIMIT, history_context["summary_token_budget"] * 4),
    )
    now = utc_now()
    covered_until = older_messages[-1].ordinal if older_messages else 0
    summary_id = existing.summary_id if existing is not None else new_id("convsum")
    created_at = existing.created_at if existing is not None else now
    summary_dir = ".academic-agent/memory/conversation-summaries"
    return ConversationSummary(
        summary_id=summary_id,
        thread_id=thread_id,
        status="frozen",
        schema_version="v0",
        summary_source="deterministic",
        provider=None,
        model=None,
        summary_text=summary_text,
        source_refs=[f"msg:{message.ordinal}" for message in older_messages],
        covered_until_ordinal=covered_until,
        covered_message_count=len(older_messages),
        markdown_path=f"{summary_dir}/{thread_id}.md",
        metadata_path=f"{summary_dir}/{thread_id}.json",
        created_at=created_at,
        updated_at=now,
    )


def _conversation_summary_system_prompt() -> str:
    return (
        "You are a context compaction assistant for an academic research agent. "
        "Rewrite the provided deterministic conversation summary into a compact, "
        "source-referenced long-term memory summary. Do not invent facts. Preserve "
        "user goals, constraints, decisions, unresolved questions, and research direction. "
        "Keep source refs like USER[3], ASSISTANT[4], or msg:4 when present. "
        "Return plain text only, no markdown table, no JSON."
    )


def _conversation_summary_user_prompt(
    summary: ConversationSummary,
    history_context: HistoryContextPacket,
) -> str:
    return (
        "Deterministic summary to refine:\n"
        f"{summary.summary_text}\n\n"
        "Compaction metadata:\n"
        f"- covered_message_count: {summary.covered_message_count}\n"
        f"- covered_until_ordinal: {summary.covered_until_ordinal}\n"
        f"- source_refs: {', '.join(summary.source_refs[:80])}\n"
        f"- excluded_context_summary: {history_context['excluded_context_summary']}\n\n"
        "Output a concise long-term memory summary in the same language mixture used by "
        "the source conversation. Keep it under roughly 900 words."
    )


def _clean_summary_text(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if "\n" in cleaned:
            first_line, rest = cleaned.split("\n", 1)
            cleaned = rest if first_line.strip().lower() in {"text", "markdown", "md"} else cleaned
    return cleaned.strip()


def _collect_user_goals(messages: list[ThreadMessage]) -> list[str]:
    return [
        f"- USER[{message.ordinal}]: {_truncate_one_line(message.content, 220)}"
        for message in messages
        if message.role == "user" and message.content.strip()
    ][-8:]


def _collect_constraints(messages: list[ThreadMessage]) -> list[str]:
    keywords = (
        "必须",
        "不要",
        "不能",
        "优先",
        "只",
        "需要",
        "约束",
        "顶会",
        "算法",
        "中文",
        "英文",
        "latest",
        "recent",
        "current",
        "arxiv",
        "preprint",
    )
    constraints: list[str] = []
    for message in messages:
        if message.role != "user":
            continue
        lowered = message.content.lower()
        if any(keyword in lowered for keyword in keywords):
            constraints.append(f"- USER[{message.ordinal}]: {_truncate_one_line(message.content, 220)}")
    return constraints[-8:]


def _collect_assistant_conclusions(messages: list[ThreadMessage]) -> list[str]:
    markers = (
        "Problem:",
        "Gap:",
        "Candidate Mechanism:",
        "Main uncertainty:",
        "问题：",
        "差距：",
        "候选机制：",
        "主要不确定性：",
        "结论",
        "不确定",
    )
    conclusions: list[str] = []
    for message in messages:
        if message.role != "assistant":
            continue
        matching_lines = [
            _truncate_one_line(line, 220)
            for line in message.content.splitlines()
            if any(marker in line for marker in markers)
        ]
        if matching_lines:
            conclusions.extend(
                f"- ASSISTANT[{message.ordinal}]: {line}" for line in matching_lines[:4]
            )
        else:
            conclusions.append(
                f"- ASSISTANT[{message.ordinal}]: {_truncate_one_line(message.content, 220)}"
            )
    return conclusions[-10:]


def _collect_open_questions(messages: list[ThreadMessage]) -> list[str]:
    questions: list[str] = []
    for message in messages:
        if message.role != "assistant":
            continue
        for line in message.content.splitlines():
            stripped = line.strip()
            if "?" in stripped or "？" in stripped:
                questions.append(f"- ASSISTANT[{message.ordinal}]: {_truncate_one_line(stripped, 220)}")
    return questions[-8:]


def _format_recent_transcript(
    messages: list[ThreadMessage],
    message_char_limit: int = COMPACT_MESSAGE_CHAR_LIMIT,
) -> str:
    if not messages:
        return "No recent non-tool messages."
    return "\n".join(
        (
            f"{message.role.upper()}[{message.ordinal}]: "
            f"{_truncate_multiline(message.content, message_char_limit)}"
        )
        for message in messages
    )


def _truncate_one_line(text: str, limit: int) -> str:
    return _truncate_text(" ".join(text.strip().split()), limit)


def _truncate_multiline(text: str, limit: int) -> str:
    return _truncate_text(text.strip(), limit)


def _truncate_text(text: str, limit: int) -> str:
    text = _redact_sensitive_text(text)
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)].rstrip() + "..."


def _redact_sensitive_text(text: str) -> str:
    redacted = SENSITIVE_ASSIGNMENT_RE.sub(r"\1=[REDACTED]", text)
    return SENSITIVE_TOKEN_RE.sub("[REDACTED_SECRET]", redacted)


def _truncate_preserving_lines(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    lines: list[str] = []
    total = 0
    for line in text.splitlines():
        projected = total + len(line) + 1
        if projected > limit:
            break
        lines.append(line)
        total = projected
    lines.append("- [truncated: older compact summary exceeded context budget]")
    return "\n".join(lines)


def _build_initial_messages(
    idea: str,
    history_context: HistoryContextPacket,
) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": _agent_system_prompt()},
    ]
    messages.append({
        "role": "user",
        "content": (
            f"Thread history:\n{history_context['prompt_text']}\n\n"
            f"Latest user input:\n{idea}\n\n"
            "Response language: use the same natural language as Latest user input for "
            "all JSON string values. If Latest user input is Chinese, write the diagnosis "
            "values and questions in Chinese. Keep JSON keys in English.\n"
            "Research this idea using paper_search with sort_by='hybrid' to include both "
            "relevant papers and recent arXiv preprints. If the user asks for latest, new, "
            "recent, current, or today's papers/preprints, use sort_by='submitted_date'. "
            "Use web_search only if paper_search is insufficient. "
            "Then produce a final diagnosis JSON."
        ),
    })
    return messages


def _build_final_synthesis_messages(
    idea: str,
    messages: list[dict[str, Any]],
    history_context: Any,
) -> list[dict[str, Any]]:
    observations = _summarize_tool_observations(messages)
    assistant_notes = _summarize_assistant_notes(messages)
    history_summary = str(history_context.get("excluded_context_summary") or "")
    return [
        {"role": "system", "content": _agent_system_prompt()},
        {
            "role": "user",
            "content": (
                f"Latest user input:\n{idea}\n\n"
                f"Thread context summary:\n{history_summary or 'No compacted history summary.'}\n\n"
                f"Tool observations:\n{observations}\n\n"
                f"Assistant intermediate notes:\n{assistant_notes}\n\n"
                "Stop using tools. Do not request more searches. Based only on the user input, "
                "thread context, and tool observations above, return one final diagnosis JSON "
                "with exactly these keys: problem, gap, candidate_mechanism, evidence_needed, "
                "main_uncertainty, clarifying_questions. Use the same natural language as the "
                "latest user input for all string values. No markdown, no prose outside JSON."
            ),
        },
    ]


def _summarize_tool_observations(messages: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for message in messages:
        if message.get("role") != "tool":
            continue
        tool_name = str(message.get("name") or "tool")
        try:
            payload = json.loads(str(message.get("content") or "{}"))
        except json.JSONDecodeError:
            lines.append(f"- {tool_name}: {_truncate_one_line(str(message.get('content') or ''), 260)}")
            continue
        query = str(payload.get("query") or "")
        error = str(payload.get("error") or "")
        raw_results = payload.get("results")
        results = raw_results if isinstance(raw_results, list) else []
        titles = [
            _truncate_one_line(str(item.get("title") or ""), 120)
            for item in results[:5]
            if isinstance(item, dict) and item.get("title")
        ]
        sources = sorted({
            str(item.get("source"))
            for item in results
            if isinstance(item, dict) and item.get("source")
        })
        line = f"- {tool_name}"
        if query:
            line += f" query={_truncate_one_line(query, 120)}"
        line += f" results={len(results)}"
        if sources:
            line += f" sources={', '.join(sources)}"
        if error:
            line += f" partial_error={_truncate_one_line(error, 180)}"
        if titles:
            line += f" titles={'; '.join(titles)}"
        lines.append(line)
    return "\n".join(lines[-12:]) if lines else "- No tool observations."


def _summarize_assistant_notes(messages: list[dict[str, Any]]) -> str:
    notes: list[str] = []
    for message in messages:
        if message.get("role") != "assistant":
            continue
        content = str(message.get("content") or "").strip()
        if content:
            notes.append(f"- {_truncate_one_line(content, 240)}")
    return "\n".join(notes[-5:]) if notes else "- No parseable intermediate assistant notes."


def _tool_decision_message(tool_calls: list[dict[str, Any]]) -> str:
    names = _unique_tool_names(tool_calls)
    if names == ["paper_search"]:
        return "我判断需要先检索近邻论文，再评估 novelty 风险。"
    if "paper_search" in names:
        return f"我判断需要调用 {', '.join(names)}，先补外部证据再诊断。"
    if "web_search" in names:
        return "我判断论文检索还不够，需要补充网页检索信息。"
    return f"我判断需要调用工具：{', '.join(names)}。"


def _unique_tool_names(tool_calls: list[dict[str, Any]]) -> list[str]:
    names: list[str] = []
    for tc in tool_calls:
        name = str(tc.get("name", "tool"))
        if name not in names:
            names.append(name)
    return names


def _tool_start_message(tool_name: str, arguments: dict[str, Any]) -> str:
    query = str(arguments.get("query", "")).strip()
    max_results = arguments.get("max_results")
    suffix = f"（最多 {max_results} 条）" if max_results else ""
    if tool_name == "paper_search":
        return f"检索近邻论文：{query}{suffix}"
    if tool_name == "web_search":
        return f"检索开放网页：{query}{suffix}"
    return f"调用工具 {tool_name}。"


def _tool_result_summary(tool_name: str, result: dict[str, Any]) -> dict[str, Any]:
    raw_results = result.get("results", [])
    results = raw_results if isinstance(raw_results, list) else []
    titles: list[str] = []
    sources: list[str] = []
    urls: list[str] = []
    for item in results[:3]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title", "")).strip()
        source = str(item.get("source", "")).strip()
        url = str(item.get("url", "")).strip()
        if title:
            titles.append(title)
        if source and source not in sources:
            sources.append(source)
        if url:
            urls.append(url)
    return {
        "query": str(result.get("query", "")),
        "source": str(result.get("source", tool_name)),
        "result_count": len(results),
        "top_titles": titles,
        "sources": sources,
        "top_urls": urls,
        "error_message": str(result.get("error", "")) if result.get("error") else None,
    }


def _tool_observation_message(
    tool_name: str,
    summary: dict[str, Any],
    is_error: bool,
) -> str:
    if is_error:
        error_message = summary.get("error_message") or "工具返回错误。"
        source = str(summary.get("source") or tool_name)
        if error_message == "工具返回错误。":
            return f"{tool_name} 没有成功完成：{source} 返回错误，未取得可用结果。"
        return f"{tool_name} 没有成功完成：{error_message}"
    count = int(summary.get("result_count", 0))
    titles = [str(title) for title in summary.get("top_titles", []) if title]
    source_text = ", ".join(str(item) for item in summary.get("sources", []) if item)
    prefix = f"{tool_name} 返回 {count} 条结果"
    if source_text:
        prefix = f"{prefix}（{source_text}）"
    error_message = summary.get("error_message")
    if error_message:
        prefix = f"{prefix}；部分来源失败：{error_message}"
    if titles:
        return f"{prefix}，我会优先参考：{'; '.join(titles)}"
    return f"{prefix}，但没有可展示的标题。"


def _stream_chunks(content: str, max_chars: int = 36) -> list[str]:
    chunks: list[str] = []
    current = ""
    for char in content:
        current += char
        if char in {"\n", "。", "？", "！", ".", "?", "!"} or len(current) >= max_chars:
            chunks.append(current)
            current = ""
    if current:
        chunks.append(current)
    return chunks or [""]


def _language_from_text(text: str) -> str:
    return "zh" if any("\u4e00" <= char <= "\u9fff" for char in text) else "en"


def _assistant_summary(
    diagnosis: Diagnosis,
    is_session_start: bool,
    language: str = "en",
) -> str:
    questions = "\n".join(f"- {question}" for question in diagnosis.clarifying_questions)
    evidence = "\n".join(f"- {item}" for item in diagnosis.evidence_needed)
    if language == "zh":
        prefix = "已生成五字段诊断。\n\n" if is_session_start else ""
        return (
            f"{prefix}"
            f"问题：{diagnosis.problem}\n\n"
            f"差距：{diagnosis.gap}\n\n"
            f"候选机制：{diagnosis.candidate_mechanism}\n\n"
            f"需要的证据：\n{evidence}\n\n"
            f"主要不确定性：{diagnosis.main_uncertainty}\n\n"
            f"澄清问题：\n{questions}"
        )

    prefix = "Updated five-field diagnosis created.\n\n" if is_session_start else ""
    return (
        f"{prefix}"
        f"Problem: {diagnosis.problem}\n\n"
        f"Gap: {diagnosis.gap}\n\n"
        f"Candidate Mechanism: {diagnosis.candidate_mechanism}\n\n"
        f"Evidence Needed:\n{evidence}\n\n"
        f"Main uncertainty: {diagnosis.main_uncertainty}\n\n"
        f"Clarifying Questions:\n{questions}"
    )


def _fallback_diagnosis(idea: str) -> Diagnosis:
    return Diagnosis(
        problem=f"用户提出的研究方向是：{idea.strip()}",
        gap="未能从 LLM 响应中提取诊断结果。",
        candidate_mechanism="需重新运行以获取诊断。",
        evidence_needed=["重新运行并检查 LLM 输出。", "确认 provider 和 prompt 配置正确。"],
        main_uncertainty="未能获取 LLM 诊断结果。",
        clarifying_questions=[],
    )


def _fallback_title(idea: str) -> str:
    cleaned = " ".join(idea.strip().split())
    return (cleaned[:57].rstrip() + "...") if len(cleaned) > 60 else cleaned or "Untitled Research Idea"


def _fallback_title_from_messages(messages: list[ThreadMessage]) -> str:
    for message in reversed(messages):
        if message.role == "user" and message.content.strip():
            return _fallback_title(message.content)
    return "Untitled Research Idea"


def _is_placeholder_title(title: str) -> bool:
    normalized = " ".join(title.strip().lower().split())
    return not normalized or normalized.startswith("untitled")
