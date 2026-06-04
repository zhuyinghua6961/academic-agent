from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest

from academic_agent_core.api import create_app
from academic_agent_core.config import AgentConfig
from academic_agent_core.graph import (
    IdeaPlanRunner,
    _build_artifact_context,
    _build_history_context,
    _tool_observation_message,
    build_context_usage,
)
from academic_agent_core.harness import ArtifactManager, MemoryManager, TraceRecorder
from academic_agent_core.providers import APP_USER_AGENT, _anthropic_headers, _normalize_openai_usage
from academic_agent_core.providers import _deepseek_context_cache_hit, _normalize_deepseek_usage
from academic_agent_core.providers import _openai_headers
from academic_agent_core.providers import _chat_tool_calls, _openai_response_tool_calls
from academic_agent_core.providers import anthropic_agent_body, create_idea_diagnosis_provider
from academic_agent_core.providers import openai_responses_agent_body, openai_responses_body
from academic_agent_core.providers import _payload_from_sse, _remove_parameter, _unsupported_parameter
from academic_agent_core.providers import (
    _iterate_chat_completions_stream,
    _iterate_openai_responses_stream,
)
from academic_agent_core.search import (
    SearchEngine,
    _arxiv_api_sort_by,
    arxiv_search_query,
    arxiv_search_queries,
    create_default_search_engine,
    parse_brave_web_results,
    parse_arxiv_feed,
    parse_openalex_works,
    parse_serpapi_results,
    parse_serper_results,
    parse_tavily_results,
)
from academic_agent_core.schemas import MemoryRecord, ProviderProfileConfig, ProviderRequest, ThreadMessage
from academic_agent_core.schemas import SearchResponse, SearchResult, utc_now
from academic_agent_core.tools import PaperSearchTool, get_default_tools
from academic_agent_core.workspace import ProjectWorkspace


class FakeSSEStreamResponse:
    def __init__(self, lines: list[str], headers: dict[str, str] | None = None) -> None:
        self._lines = lines
        self.headers = headers or {}

    def iter_lines(self):
        yield from self._lines


def test_workspace_init_creates_required_dirs_and_database(tmp_path: Path) -> None:
    workspace = ProjectWorkspace(tmp_path)

    status = workspace.init()

    assert status.initialized is True
    assert Path(status.db_path).exists()
    for directory in ("artifacts", "traces", "memory", "cache"):
        assert (tmp_path / ".academic-agent" / directory).is_dir()
    assert (tmp_path / ".academic-agent" / "memory" / "project-memory-map.md").exists()
    assert (tmp_path / ".academic-agent" / "config.toml").exists()


def test_workspace_rename_and_lookup_thread_by_name(tmp_path: Path) -> None:
    workspace = ProjectWorkspace(tmp_path)
    workspace.init()

    first_thread = workspace.create_thread()
    second_thread = workspace.create_thread()

    renamed = workspace.rename_thread(first_thread.thread_id, "resume-me")

    assert renamed.name == "resume-me"
    assert workspace.find_thread_by_name("resume-me").thread_id == first_thread.thread_id
    assert workspace.get_thread(first_thread.thread_id).name == "resume-me"
    assert workspace.list_threads()[0].thread_id == second_thread.thread_id

    with pytest.raises(ValueError):
        workspace.rename_thread(second_thread.thread_id, "resume-me")


def test_provider_config_defaults_to_mock_and_env_status_is_secret_safe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("ACADEMIC_AGENT_PROVIDER", raising=False)
    monkeypatch.delenv("ACADEMIC_AGENT_MODEL", raising=False)
    monkeypatch.delenv("ACADEMIC_AGENT_ENABLE_LIVE_PROVIDERS", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "secret-value-that-must-not-leak")

    workspace = ProjectWorkspace(tmp_path)
    workspace.init()
    config = AgentConfig.load(tmp_path)
    planner = config.profile("planner")
    status = [item for item in config.statuses() if item.profile == "planner"][0]

    assert planner.provider == "mock"
    assert status.provider == "mock"
    assert status.has_api_key is False
    assert "secret-value-that-must-not-leak" not in status.model_dump_json()


def test_provider_env_override_requires_live_gate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ACADEMIC_AGENT_PROVIDER", "openai")
    monkeypatch.setenv("ACADEMIC_AGENT_MODEL", "gpt-test")
    monkeypatch.setenv("ACADEMIC_AGENT_BASE_URL", "https://llm-gateway.example.test/v1")
    monkeypatch.setenv("ACADEMIC_AGENT_REASONING_EFFORT", "high")
    monkeypatch.setenv("ACADEMIC_AGENT_REASONING_SUMMARY", "auto")
    monkeypatch.setenv("OPENAI_API_KEY", "secret-value-that-must-not-leak")
    monkeypatch.delenv("ACADEMIC_AGENT_ENABLE_LIVE_PROVIDERS", raising=False)

    workspace = ProjectWorkspace(tmp_path)
    workspace.init()
    config = AgentConfig.load(tmp_path)
    status = [item for item in config.statuses() if item.profile == "planner"][0]

    assert status.provider == "openai"
    assert status.model == "gpt-test"
    assert status.base_url == "https://llm-gateway.example.test/v1"
    assert status.reasoning_effort == "high"
    assert status.reasoning_summary == "auto"
    assert status.has_api_key is True
    assert status.live_enabled is False
    assert status.will_use_live is False
    assert "secret-value-that-must-not-leak" not in status.model_dump_json()


def test_project_dotenv_supplies_key_and_live_gate_without_leaking_secret(tmp_path: Path) -> None:
    workspace = ProjectWorkspace(tmp_path)
    workspace.init()
    (tmp_path / ".academic-agent" / "config.toml").write_text(
        "\n".join(
            [
                "[providers.planner]",
                'provider = "openai"',
                'model = "gpt-test"',
                'api_key_env = "OPENAI_API_KEY"',
                'base_url = "https://gateway.example.test/v1"',
                'reasoning_effort = "medium"',
            ]
        ),
        encoding="utf-8",
    )
    (tmp_path / ".academic-agent" / ".env").write_text(
        "OPENAI_API_KEY=secret-value-that-must-not-leak\n"
        "ACADEMIC_AGENT_ENABLE_LIVE_PROVIDERS=1\n",
        encoding="utf-8",
    )

    config = AgentConfig.load(tmp_path, env={})
    status = [item for item in config.statuses() if item.profile == "planner"][0]

    assert status.has_api_key is True
    assert status.live_enabled is True
    assert status.will_use_live is True
    assert status.reasoning_effort == "medium"
    assert "secret-value-that-must-not-leak" not in status.model_dump_json()


def test_search_config_uses_env_key_names_without_leaking_secret(tmp_path: Path) -> None:
    workspace = ProjectWorkspace(tmp_path)
    workspace.init()
    (tmp_path / ".academic-agent" / "config.toml").write_text(
        "\n".join(
            [
                "[search]",
                'paper_sources = ["arxiv", "openalex"]',
                'web_sources = ["brave", "tavily", "serper", "serpapi", "duckduckgo"]',
                "",
                "[search.brave]",
                'api_key_env = "BRAVE_SEARCH_API_KEY"',
            ]
        ),
        encoding="utf-8",
    )
    (tmp_path / ".academic-agent" / ".env").write_text(
        "BRAVE_SEARCH_API_KEY=secret-value-that-must-not-leak\n",
        encoding="utf-8",
    )

    config = AgentConfig.load(tmp_path, env={})
    engine = create_default_search_engine(config.search, config.env)

    assert config.search.paper_sources == ["arxiv", "openalex"]
    assert config.search.web_sources[:3] == ["brave", "tavily", "serper"]
    assert config.search.providers["brave"].api_key_env == "BRAVE_SEARCH_API_KEY"
    assert "brave" in engine.providers
    assert "secret-value-that-must-not-leak" not in repr(config.search.providers["brave"].__dict__)


def test_openai_responses_body_includes_reasoning_when_configured() -> None:
    config = ProviderProfileConfig(
        profile="planner",
        provider="openai",
        model="gpt-5.1",
        api_key_env="OPENAI_API_KEY",
        base_url="https://api.openai.com/v1",
        max_output_tokens=3000,
        temperature=0.2,
        reasoning_effort="medium",
        reasoning_summary="auto",
    )

    body = openai_responses_body(config, "agentic research planning")

    assert body["model"] == "gpt-5.1"
    assert body["max_output_tokens"] == 3000
    assert body["input"][0]["role"] == "user"
    assert "Thread history:\nNo previous discussion in this thread." in body["input"][0]["content"]
    assert "Latest user input:\nagentic research planning" in body["input"][0]["content"]
    assert "Response language: use the same natural language" in body["input"][0]["content"]
    assert body["reasoning"] == {"effort": "medium", "summary": "auto"}


def test_openai_responses_body_includes_prompt_cache_controls() -> None:
    config = ProviderProfileConfig(
        profile="planner",
        provider="openai",
        model="gpt-5.5",
        api_key_env="OPENAI_API_KEY",
        base_url="https://api.openai.com/v1",
    )

    body = openai_responses_body(config, "cache-me", prompt_cache_key="abc123")

    assert body["prompt_cache_key"] == "abc123"
    assert body["prompt_cache_retention"] == "24h"


def test_agent_body_builders_convert_tool_protocols() -> None:
    config = ProviderProfileConfig(
        profile="planner",
        provider="openai",
        model="gpt-5.5",
        api_key_env="OPENAI_API_KEY",
        base_url="https://api.openai.com/v1",
        max_output_tokens=3000,
        reasoning_effort="medium",
        reasoning_summary="auto",
    )
    tools = [
        {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the web.",
                "parameters": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
            },
        }
    ]
    messages = [
        {"role": "system", "content": "System instructions"},
        {"role": "user", "content": "Find related work"},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "web_search",
                        "arguments": '{"query":"academic agent"}',
                    },
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": '{"results":[]}'},
    ]

    openai_body = openai_responses_agent_body(config, messages, tools, prompt_cache_key="cache")
    anthropic_body = anthropic_agent_body(config, messages, tools)

    assert openai_body["instructions"] == "System instructions"
    assert openai_body["tools"][0]["name"] == "web_search"
    assert openai_body["input"][1]["type"] == "function_call"
    assert openai_body["input"][2]["type"] == "function_call_output"
    assert openai_body["reasoning"] == {"effort": "medium", "summary": "auto"}
    assert anthropic_body["system"] == "System instructions"
    assert anthropic_body["tools"][0]["input_schema"]["required"] == ["query"]
    assert anthropic_body["messages"][1]["content"][0]["type"] == "tool_use"
    assert anthropic_body["messages"][2]["content"][0]["type"] == "tool_result"


def test_tool_call_parsers_normalize_provider_payloads() -> None:
    chat_message = {
        "tool_calls": [
            {
                "id": "call_1",
                "function": {"name": "web_search", "arguments": '{"query":"x"}'},
            },
            {
                "id": "call_2",
                "function": {"name": "web_search", "arguments": "{bad json"},
            },
        ]
    }
    responses_payload = {
        "output": [
            {
                "type": "function_call",
                "call_id": "call_3",
                "name": "web_search",
                "arguments": '{"query":"y"}',
            }
        ]
    }

    chat_calls = _chat_tool_calls(chat_message)
    response_calls = _openai_response_tool_calls(responses_payload)

    assert chat_calls[0]["arguments"] == {"query": "x"}
    assert chat_calls[1]["arguments"] == {}
    assert response_calls == [
        {"call_id": "call_3", "name": "web_search", "arguments": {"query": "y"}}
    ]


def test_provider_headers_use_app_user_agent() -> None:
    assert _openai_headers("secret")["user-agent"] == APP_USER_AGENT
    assert _anthropic_headers("secret")["user-agent"] == APP_USER_AGENT


def test_openai_usage_normalizer_reads_prompt_token_details_cache_hits() -> None:
    usage = {
        "prompt_tokens": 1200,
        "completion_tokens": 80,
        "total_tokens": 1280,
        "prompt_tokens_details": {"cached_tokens": 900},
    }

    normalized = _normalize_openai_usage(usage)

    assert normalized["cache_read_tokens"] == 900
    assert normalized["input_tokens_details"] == {"cached_tokens": 900}


def test_provider_request_hash_is_stable_without_context_id() -> None:
    config = ProviderProfileConfig(
        profile="planner",
        provider="openai",
        model="gpt-5.5",
        api_key_env="OPENAI_API_KEY",
        base_url="https://api.openai.com/v1",
    )

    body_a = openai_responses_body(config, "cache-me")
    body_b = openai_responses_body(config, "cache-me")

    assert body_a["input"][0]["content"] == body_b["input"][0]["content"]


def test_provider_request_hash_ignores_runtime_message_ids() -> None:
    config = ProviderProfileConfig(
        profile="planner",
        provider="openai",
        model="gpt-5.5",
        api_key_env="OPENAI_API_KEY",
        base_url="https://api.openai.com/v1",
    )
    history_a = [
        {"message_id": "msg_a", "thread_id": "thread", "role": "user", "content": "A", "run_id": "run1", "created_at": "1", "ordinal": 1},
    ]
    history_b = [
        {"message_id": "msg_b", "thread_id": "thread", "role": "user", "content": "A", "run_id": "run2", "created_at": "2", "ordinal": 9},
    ]

    body_a = openai_responses_body(config, "cache-me", [ThreadMessage.model_validate(item) for item in history_a])
    body_b = openai_responses_body(config, "cache-me", [ThreadMessage.model_validate(item) for item in history_b])

    assert body_a["input"][0]["content"] == body_b["input"][0]["content"]


def test_unsupported_parameter_helpers_remove_top_level_and_nested_fields() -> None:
    body = {
        "max_output_tokens": 3000,
        "reasoning": {"effort": "high", "summary": "auto"},
    }

    assert _unsupported_parameter('{"detail":"Unsupported parameter: max_output_tokens"}') == (
        "max_output_tokens"
    )
    assert _remove_parameter(body, "max_output_tokens") is True
    assert "max_output_tokens" not in body
    assert _remove_parameter(body, "reasoning.summary") is True
    assert body["reasoning"] == {"effort": "high"}


def test_payload_from_sse_returns_completed_response_payload() -> None:
    text = (
        'event: response.created\n'
        'data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n'
        'event: response.output_text.delta\n'
        'data: {"type":"response.output_text.delta","delta":"hello"}\n\n'
        'event: response.output_text.delta\n'
        'data: {"type":"response.output_text.delta","delta":" world"}\n\n'
        'event: response.completed\n'
        'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[]}}\n\n'
    )

    payload = _payload_from_sse(text)

    assert payload == {
        "id": "resp_1",
        "status": "completed",
        "output": [],
        "output_text": "hello world",
    }


def test_openai_responses_stream_parser_emits_content_and_final_response() -> None:
    request = ProviderRequest(
        request_id="provider_req_1",
        provider="openai",
        model="gpt-test",
        profile="planner",
        messages=[],
        prompt_version="test",
        input_hash="hash",
        created_at=utc_now(),
    )
    response = FakeSSEStreamResponse(
        [
            'data: {"type":"response.output_text.delta","delta":"{\\"problem\\":"}\n',
            'data: {"type":"response.output_text.delta","delta":"\\"x\\"}"}\n',
            (
                'data: {"type":"response.completed","response":{"id":"resp_1",'
                '"status":"completed","output":[{"type":"message","content":[{"type":"output_text",'
                '"text":"{\\"problem\\":\\"x\\"}"}]}],"usage":{"input_tokens":10,"output_tokens":3}}}\n'
            ),
            "data: [DONE]\n",
        ],
        headers={"x-request-id": "req_test"},
    )

    chunks = list(
        _iterate_openai_responses_stream(
            response,  # type: ignore[arg-type]
            request=request,
            provider="openai",
            model="gpt-test",
        )
    )

    assert [chunk["type"] for chunk in chunks] == [
        "content_delta",
        "content_delta",
        "completed",
    ]
    assert chunks[-1]["response"].output["content"] == '{"problem":"x"}'
    assert chunks[-1]["response"].provider_request_id == "req_test"


def test_chat_completions_stream_parser_reconstructs_tool_calls() -> None:
    request = ProviderRequest(
        request_id="provider_req_2",
        provider="deepseek",
        model="deepseek-chat",
        profile="planner",
        messages=[],
        prompt_version="test",
        input_hash="hash",
        created_at=utc_now(),
    )
    response = FakeSSEStreamResponse(
        [
            'data: {"id":"chat_1","choices":[{"delta":{"content":"hello "}}]}\n',
            'data: {"id":"chat_1","choices":[{"delta":{"content":"world"}}]}\n',
            (
                'data: {"id":"chat_1","choices":[{"delta":{"tool_calls":[{"index":0,'
                '"id":"call_1","function":{"name":"paper_search","arguments":"{\\"query\\":"}}]}}]}\n'
            ),
            (
                'data: {"id":"chat_1","choices":[{"delta":{"tool_calls":[{"index":0,'
                '"function":{"arguments":"\\"agent planning\\"}"}}]}}]}\n'
            ),
            (
                'data: {"id":"chat_1","choices":[{"finish_reason":"tool_calls","delta":{}}],'
                '"usage":{"prompt_tokens":12,"completion_tokens":4,"prompt_cache_hit_tokens":3}}\n'
            ),
            "data: [DONE]\n",
        ],
        headers={"x-request-id": "req_chat"},
    )

    chunks = list(
        _iterate_chat_completions_stream(
            response,  # type: ignore[arg-type]
            request=request,
            provider="deepseek",
            model="deepseek-chat",
        )
    )

    assert "".join(str(chunk.get("delta", "")) for chunk in chunks) == "hello world"
    final = chunks[-1]["response"]
    assert final.output["content"] == "hello world"
    assert final.output["finish_reason"] == "tool_calls"
    assert final.output["tool_calls"] == [
        {
            "call_id": "call_1",
            "name": "paper_search",
            "arguments": {"query": "agent planning"},
        }
    ]
    assert final.usage["cache_read_tokens"] == 3


def test_arxiv_query_builder_and_feed_parser() -> None:
    feed = """<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom"
          xmlns:arxiv="http://arxiv.org/schemas/atom">
      <entry>
        <id>http://arxiv.org/abs/2401.00001v1</id>
        <updated>2024-01-02T00:00:00Z</updated>
        <published>2024-01-01T00:00:00Z</published>
        <title> Academic Agent Planning </title>
        <summary> A paper about research planning agents. </summary>
        <author><name>Ada Lovelace</name></author>
        <arxiv:primary_category term="cs.AI" />
        <category term="cs.AI" />
        <link href="http://arxiv.org/abs/2401.00001v1" rel="alternate" type="text/html"/>
        <link title="pdf" href="http://arxiv.org/pdf/2401.00001v1" rel="related"
              type="application/pdf"/>
      </entry>
    </feed>
    """

    results = parse_arxiv_feed(feed, retrieved_at="2026-05-29T00:00:00+00:00")

    assert arxiv_search_query("academic agent planning") == (
        "all:academic AND all:agent AND all:planning"
    )
    assert arxiv_search_queries("world model drone UAV navigation planning RSSM")[:3] == [
        "all:world AND all:model AND all:drone AND all:UAV AND all:navigation AND all:planning AND all:RSSM",
        "all:world AND all:model AND all:drone AND all:UAV",
        "all:world AND all:model AND all:drone",
    ]
    assert arxiv_search_query("ti:agent AND abs:planning") == "ti:agent AND abs:planning"
    assert _arxiv_api_sort_by("relevance") == "relevance"
    assert _arxiv_api_sort_by("hybrid") == "relevance"
    assert _arxiv_api_sort_by("submitted_date") == "submittedDate"
    assert results[0].source == "arxiv"
    assert results[0].external_id == "2401.00001v1"
    assert results[0].title == "Academic Agent Planning"
    assert results[0].authors == ["Ada Lovelace"]
    assert results[0].pdf_url == "http://arxiv.org/pdf/2401.00001v1"
    assert results[0].metadata["primary_category"] == "cs.AI"


def test_openalex_parser_extracts_landing_page_and_authors() -> None:
    payload = {
        "results": [
            {
                "id": "https://openalex.org/W1234567890",
                "title": "Academic Agent Planning",
                "publication_date": "2024-01-01",
                "updated_date": "2024-01-02T00:00:00Z",
                "abstract_inverted_index": {"academic": [0], "agent": [1], "planning": [2]},
                "authorships": [
                    {"author": {"display_name": "Ada Lovelace"}},
                    {"author": {"display_name": "Alan Turing"}},
                ],
                "primary_location": {
                    "landing_page_url": "https://example.org/paper",
                    "pdf_url": "https://example.org/paper.pdf",
                },
                "doi": "https://doi.org/10.1234/example",
                "cited_by_count": 7,
                "publication_year": 2024,
            }
        ]
    }

    results = parse_openalex_works(payload, query="academic agent", retrieved_at="2026-05-29T00:00:00+00:00")

    assert len(results) == 1
    assert results[0].source == "openalex"
    assert results[0].title == "Academic Agent Planning"
    assert results[0].snippet == "academic agent planning"
    assert results[0].authors == ["Ada Lovelace", "Alan Turing"]
    assert results[0].url == "https://example.org/paper"
    assert results[0].pdf_url == "https://example.org/paper.pdf"
    assert results[0].metadata["openalex_id"] == "https://openalex.org/W1234567890"


def test_paid_web_search_parsers_normalize_results() -> None:
    brave = parse_brave_web_results(
        {"web": {"results": [{"title": "Brave Result", "url": "https://b.test", "description": "B"}]}},
        retrieved_at="2026-05-29T00:00:00+00:00",
    )
    tavily = parse_tavily_results(
        {"results": [{"title": "Tavily Result", "url": "https://t.test", "content": "T", "score": 0.9}]},
        retrieved_at="2026-05-29T00:00:00+00:00",
    )
    serper = parse_serper_results(
        {"organic": [{"title": "Serper Result", "link": "https://s.test", "snippet": "S"}]},
        retrieved_at="2026-05-29T00:00:00+00:00",
    )
    serpapi = parse_serpapi_results(
        {"organic_results": [{"title": "SerpAPI Result", "link": "https://g.test", "snippet": "G"}]},
        retrieved_at="2026-05-29T00:00:00+00:00",
    )

    assert brave[0].source == "brave"
    assert tavily[0].metadata["score"] == 0.9
    assert serper[0].source == "serper"
    assert serpapi[0].source == "serpapi"


def test_paper_search_tool_uses_search_engine_contract() -> None:
    class FakeSearchEngine:
        def paper_search(
            self,
            query: str,
            max_results: int = 8,
            sources: list[str] | None = None,
            sort_by: str = "hybrid",
        ) -> SearchResponse:
            return SearchResponse(
                query=query,
                source="paper_search",
                retrieved_at=utc_now(),
                results=[
                    SearchResult(
                        source="arxiv",
                        title="Nearby Paper",
                        snippet="A close related work.",
                        url="https://arxiv.org/abs/1234.5678",
                        retrieved_at=utc_now(),
                        external_id="1234.5678",
                        metadata={
                            "max_results": max_results,
                            "sources": sources or [],
                            "sort_by": sort_by,
                        },
                    )
                ],
            )

    tool = PaperSearchTool(FakeSearchEngine())  # type: ignore[arg-type]

    result = tool.execute(
        {
            "query": "nearby work",
            "max_results": 50,
            "sources": ["arxiv"],
            "sort_by": "submitted_date",
        }
    )

    assert result["query"] == "nearby work"
    assert result["source"] == "paper_search"
    assert result["results"][0]["source"] == "arxiv"
    assert result["results"][0]["metadata"]["max_results"] == 10
    assert result["results"][0]["metadata"]["sources"] == ["arxiv"]
    assert result["results"][0]["metadata"]["sort_by"] == "submitted_date"


def test_idea_plan_tool_node_writes_paper_search_evidence_artifact(tmp_path: Path) -> None:
    class FakeSearchEngine:
        def paper_search(
            self,
            query: str,
            max_results: int = 8,
            sources: list[str] | None = None,
            sort_by: str = "hybrid",
        ) -> SearchResponse:
            return SearchResponse(
                query=query,
                source="paper_search",
                retrieved_at=utc_now(),
                results=[
                    SearchResult(
                        source="arxiv",
                        title="Tool Evidence Paper",
                        snippet="Evidence created by the tool node.",
                        url="https://arxiv.org/abs/2401.00002",
                        retrieved_at=utc_now(),
                    )
                ],
            )

    workspace = ProjectWorkspace(tmp_path)
    runner = IdeaPlanRunner(workspace)
    runner.tool_registry = get_default_tools(FakeSearchEngine())  # type: ignore[arg-type]
    run = runner.create_run("Need a paper search artifact")

    runner._tools_node(  # type: ignore[attr-defined]
        {
            "run_id": run.run_id,
            "thread_id": run.thread_id,
            "tool_calls": [
                {
                    "call_id": "call_1",
                    "name": "paper_search",
                    "arguments": {"query": "academic agent planning", "max_results": 2},
                }
            ],
            "messages": [],
        }
    )

    events = workspace.list_events(run.run_id)
    evidence_event = [
        event for event in events if event.event_type == "paper_search.evidence.created"
    ][0]
    artifact_id = evidence_event.payload["artifact_id"]
    metadata, content = ArtifactManager(workspace).read_artifact_content(str(artifact_id))

    assert metadata.artifact_type == "PaperSearchEvidence"
    assert metadata.status == "frozen"
    assert "Tool Evidence Paper" in content
    assert "academic agent planning" in content


def test_default_tool_registry_exposes_paper_search_before_web_search() -> None:
    definitions = get_default_tools().get_all_definitions()
    names = [item["function"]["name"] for item in definitions]

    assert names[:2] == ["paper_search", "web_search"]


def test_search_engine_merges_sources_and_dedupes() -> None:
    class FakeProvider:
        def __init__(self, source: str, titles: list[str]) -> None:
            self.source = source
            self.titles = titles

        def search(self, query: str, max_results: int = 8) -> list[SearchResult]:
            return [
                SearchResult(
                    source=self.source,
                    title=title,
                    snippet=query,
                    url=f"https://example.test/{title.lower().replace(' ', '-')}",
                    retrieved_at=utc_now(),
                    external_id="same-id" if title == "Duplicate" else title,
                )
                for title in self.titles[:max_results]
            ]

    engine = SearchEngine(
        [
            FakeProvider("arxiv", ["Duplicate", "Arxiv Only"]),  # type: ignore[list-item]
            FakeProvider("openalex", ["Duplicate", "OpenAlex Only"]),  # type: ignore[list-item]
            FakeProvider("duckduckgo", ["Duplicate", "Web Only"]),  # type: ignore[list-item]
        ]
    )

    response = engine.paper_search("query", max_results=5)

    assert [result.title for result in response.results] == [
        "Duplicate",
        "Arxiv Only",
        "OpenAlex Only",
    ]


def test_search_engine_cools_down_rate_limited_source() -> None:
    class RateLimitedProvider:
        source = "arxiv"

        def __init__(self) -> None:
            self.calls = 0

        def search(self, query: str, max_results: int = 8) -> list[SearchResult]:
            self.calls += 1
            request = httpx.Request("GET", "https://export.arxiv.org/api/query")
            response = httpx.Response(429, request=request)
            raise httpx.HTTPStatusError("429 rate limit", request=request, response=response)

    class WorkingProvider:
        source = "openalex"

        def search(self, query: str, max_results: int = 8) -> list[SearchResult]:
            return [
                SearchResult(
                    source="openalex",
                    title="OpenAlex fallback",
                    url="https://openalex.org/W1",
                    retrieved_at=utc_now(),
                )
            ]

    arxiv = RateLimitedProvider()
    engine = SearchEngine(
        providers=[arxiv, WorkingProvider()],  # type: ignore[list-item]
        paper_sources=["arxiv", "openalex"],
    )

    first = engine.paper_search("world model drone", max_results=3)
    second = engine.paper_search("world model drone", max_results=3)

    assert first.results[0].source == "openalex"
    assert "429 rate limit" in str(first.error)
    assert second.results[0].source == "openalex"
    assert "skipped after recent rate limit" in str(second.error)
    assert arxiv.calls == 1


def test_idea_plan_stub_writes_run_events_artifact_and_trace(tmp_path: Path) -> None:
    workspace = ProjectWorkspace(tmp_path)

    result = IdeaPlanRunner(workspace).run("AI co-reading agent for top-conference idea planning")

    assert result.run.status == "completed"
    assert result.run.artifact_id == result.artifact.artifact_id
    assert result.draft.diagnosis.problem.startswith("用户提出的研究方向")
    assert result.draft.diagnosis.clarifying_questions
    assert Path(result.artifact.path).exists()
    assert Path(result.artifact.metadata_path).exists()

    events = workspace.list_events(result.run.run_id)
    event_types = [event.event_type for event in events]
    assert "run.created" in event_types
    assert "run.running" in event_types
    assert "agent.thinking" in event_types
    assert "activity.started" in event_types
    assert "activity.updated" in event_types
    assert "activity.completed" in event_types
    assert "provider.requested" in event_types
    assert "provider.responded" in event_types
    assert "assistant.delta" in event_types
    assert "assistant.completed" in event_types
    assert "context.built" in event_types
    assert "thread.title.requested" in event_types
    assert "thread.title.generated" in event_types
    assert "trace.recorded" in event_types
    assert "artifact.created" in event_types
    assert "memory.map.updated" in event_types
    assert "run.completed" in event_types
    provider_event = [event for event in events if event.event_type == "provider.requested"][0]
    assert provider_event.payload["provider"] == "mock"
    assert provider_event.payload["profile"] == "planner"
    assert provider_event.payload["reasoning_effort"] is None
    responded_event = [event for event in events if event.event_type == "provider.responded"][0]
    assert responded_event.payload["has_tool_calls"] is False
    assert "usage" in responded_event.payload
    activity_messages = [
        str(event.payload["message"])
        for event in events
        if event.event_type.startswith("activity.")
    ]
    assert any("planner" in message for message in activity_messages)
    assistant_delta_text = "".join(
        str(event.payload["delta"])
        for event in events
        if event.event_type == "assistant.delta"
    )
    assert "Problem:" in assistant_delta_text
    assert event_types.index("assistant.delta") < event_types.index("run.completed")
    title_event = [event for event in events if event.event_type == "thread.title.generated"][0]
    assert title_event.payload["title"] == "AI co-reading agent for top-conference idea planning"
    assert workspace.get_thread(result.run.thread_id).name == (
        "AI co-reading agent for top-conference idea planning"
    )

    metadata, content = ArtifactManager(workspace).read_artifact_content(result.artifact.artifact_id)
    assert metadata.artifact_id == result.artifact.artifact_id
    assert "## Candidate Mechanism" in content
    assert "## Clarifying Questions" in content

    messages = workspace.list_messages(result.run.thread_id)
    roles = [message.role for message in messages]
    assert roles == ["user", "assistant"]
    assert messages[0].content == "AI co-reading agent for top-conference idea planning"
    assert "Updated five-field diagnosis" in messages[-1].content

    trace = workspace.get_trace(result.artifact.trace_refs[0])
    payload = TraceRecorder(workspace).read_payload(trace)
    assert payload["payload"]["decision"] == "create ResearchIdeaPlanDraft artifact"
    assert payload["payload"]["generated_thread_title"] == (
        "AI co-reading agent for top-conference idea planning"
    )
    assert "agent_iterations" in payload["payload"]

    memory_map = MemoryManager(workspace).read_project_memory_map()
    assert memory_map.record_count >= 1
    assert any(record.record_type == "current_plan" for record in memory_map.records)
    memory_markdown = MemoryManager(workspace).read_project_memory_markdown()
    assert "## Current Research State" in memory_markdown
    assert result.artifact.artifact_id in memory_markdown


def test_chinese_user_input_gets_chinese_assistant_summary(tmp_path: Path) -> None:
    workspace = ProjectWorkspace(tmp_path)

    result = IdeaPlanRunner(workspace).run("多模态rag")

    messages = workspace.list_messages(result.run.thread_id)
    assistant_message = messages[-1].content
    assert result.draft.diagnosis.problem == "用户提出的研究方向是：多模态rag"
    assert "已生成五字段诊断" in assistant_message
    assert "问题：" in assistant_message
    assert "差距：" in assistant_message
    assert "候选机制：" in assistant_message
    assert "需要的证据：" in assistant_message
    assert "主要不确定性：" in assistant_message
    assert "澄清问题：" in assistant_message
    assert "Problem:" not in assistant_message
    assert "Gap:" not in assistant_message

    events = workspace.list_events(result.run.run_id)
    assistant_delta_text = "".join(
        str(event.payload["delta"])
        for event in events
        if event.event_type == "assistant.delta"
    )
    assert "已生成五字段诊断" in assistant_delta_text
    assert "问题：" in assistant_delta_text


def test_history_context_compacts_older_messages_and_keeps_recent_exact(tmp_path: Path) -> None:
    workspace = ProjectWorkspace(tmp_path)
    workspace.init()
    thread = workspace.create_thread()
    for index in range(1, 9):
        workspace.add_message(
            thread.thread_id,
            "user",
            f"旧目标 {index}: 必须保留算法创新约束，并讨论方向 {index}。",
        )
        workspace.add_message(
            thread.thread_id,
            "assistant",
            (
                f"问题：方向 {index} 的核心问题。\n"
                f"差距：近邻工作还需要确认。\n"
                f"澄清问题：这个方向的数据条件是什么？"
            ),
        )

    history = workspace.list_messages(thread.thread_id)
    packet = _build_history_context(history, recent_message_limit=4, summary_char_limit=1200)

    assert packet["compacted"] is True
    assert packet["total_message_count"] == 16
    assert packet["older_message_count"] == 12
    assert packet["recent_message_count"] == 4
    assert "Older compact summary" in packet["prompt_text"]
    assert "Recent exact transcript (4 messages)" in packet["prompt_text"]
    assert "USER[15]" in packet["prompt_text"]
    assert "ASSISTANT[16]" in packet["prompt_text"]
    assert "User constraints / preferences" in packet["prompt_text"]
    assert "Agent conclusions / diagnosis updates" in packet["prompt_text"]
    assert "Open questions / unresolved items" in packet["prompt_text"]
    assert packet["source_refs"][0] == "msg:1"
    assert packet["source_refs"][-1] == "msg:16"
    assert packet["persistent_summary_id"] is None


def test_artifact_first_context_injects_plan_review_and_paper_evidence(
    tmp_path: Path,
) -> None:
    workspace = ProjectWorkspace(tmp_path)
    result = IdeaPlanRunner(workspace).run("无人机重复窗户实例定位")
    artifact_manager = ArtifactManager(workspace)
    workspace.record_idea_review(
        result.run.thread_id,
        result.artifact.artifact_id,
        result.run.run_id,
        "Revise",
        "需要补强近邻文献和可区分机制。",
    )
    artifact_manager.write_paper_search_evidence(
        result.run.run_id,
        SearchResponse(
            query="drone facade window localization repeated windows",
            source="paper_search",
            retrieved_at=utc_now(),
            results=[
                SearchResult(
                    source="arxiv",
                    title="Geometry-Aware Facade Element Localization",
                    snippet="A relevant paper about facade structure.",
                    url="https://arxiv.org/abs/2601.00001",
                    retrieved_at=utc_now(),
                    authors=["Ada Researcher"],
                    published_at="2026-01-01",
                )
            ],
        ),
    )

    config = AgentConfig.load(tmp_path).context_compaction
    artifact_context = _build_artifact_context(
        workspace,
        artifact_manager,
        result.run.thread_id,
        config,
        "gpt-5.1",
        900,
    )
    packet = _build_history_context(
        workspace.list_messages(result.run.thread_id),
        latest_input="继续讨论 novelty",
        compaction_config=config,
        model="gpt-5.1",
        max_output_tokens=900,
        artifact_context=artifact_context,
    )
    usage = build_context_usage(workspace, result.run.thread_id)

    assert artifact_context["estimated_tokens"] > 0
    assert "Current Research Idea Artifact" in packet["prompt_text"]
    assert "Latest Idea Review Gate" in packet["prompt_text"]
    assert "Recent Paper Search Evidence" in packet["prompt_text"]
    assert "Geometry-Aware Facade Element Localization" in packet["prompt_text"]
    assert f"artifact:{result.artifact.artifact_id}" in packet["artifact_source_refs"]
    assert any(ref.startswith("review:") for ref in packet["artifact_source_refs"])
    assert any(ref.startswith("paper_evidence:") for ref in packet["artifact_source_refs"])
    assert usage.estimated_artifact_tokens > 0
    assert usage.artifact_source_count >= 3


def test_memory_search_conflicts_and_stale_recheck(tmp_path: Path) -> None:
    workspace = ProjectWorkspace(tmp_path)
    result = IdeaPlanRunner(workspace).run("无人机重复窗户实例定位")
    manager = MemoryManager(workspace)

    search = manager.search_memory("无人机重复窗户实例定位", thread_id=result.run.thread_id)

    assert search.results
    assert search.results[0].record.record_type == "current_plan"
    assert search.results[0].score > 0

    workspace.record_idea_review(
        result.run.thread_id,
        result.artifact.artifact_id,
        result.run.run_id,
        "Reject",
        "Novelty is too weak.",
    )
    workspace.record_idea_review(
        result.run.thread_id,
        result.artifact.artifact_id,
        result.run.run_id,
        "Advance",
        "Novelty risk is now addressed.",
    )
    conflicts = manager.detect_conflicts()

    assert any(conflict.conflict_type == "review_decision_conflict" for conflict in conflicts)
    assert workspace.list_conflict_records(thread_id=result.run.thread_id, status="open")

    old_time = datetime(2020, 1, 1, tzinfo=timezone.utc).isoformat()
    stale_record = MemoryRecord(
        record_id="memory_old_paper_evidence",
        thread_id=result.run.thread_id,
        record_type="paper_evidence",
        title="Old paper evidence",
        summary="Query: old UAV window papers",
        source_refs=["paper_evidence:old"],
        artifact_refs=[],
        status="active",
        importance=3,
        created_at=old_time,
        updated_at=old_time,
    )
    workspace.upsert_memory_record(stale_record)

    stale_count = manager.recheck_stale_records()
    stale_records = workspace.list_memory_records(
        thread_id=result.run.thread_id,
        record_type="paper_evidence",
        limit=10,
    )

    assert stale_count >= 1
    assert any(record.record_id == stale_record.record_id and record.status == "stale" for record in stale_records)


def test_idea_plan_records_context_compaction_for_long_thread(tmp_path: Path) -> None:
    workspace = ProjectWorkspace(tmp_path)
    workspace.init()
    (tmp_path / ".academic-agent" / "config.toml").write_text(
        "\n".join(
            [
                "[context.compaction]",
                "context_window_tokens = 10000",
                "max_history_tokens = 80",
                "compact_trigger_ratio = 0.75",
                "min_recent_messages = 2",
                "max_recent_messages = 4",
                "important_message_limit = 3",
            ]
        ),
        encoding="utf-8",
    )
    thread = workspace.create_thread()
    for index in range(1, 8):
        workspace.add_message(thread.thread_id, "user", f"历史用户输入 {index}: 需要顶会算法创新。")
        workspace.add_message(
            thread.thread_id,
            "assistant",
            f"问题：历史诊断 {index}\n主要不确定性：novelty 尚未确认。",
        )

    result = IdeaPlanRunner(workspace).run("继续讨论最新方案", thread_id=thread.thread_id)
    events = workspace.list_events(result.run.run_id)
    compact_event = [event for event in events if event.event_type == "context.compacted"][0]
    summary_event = [event for event in events if event.event_type == "memory.summary.updated"][0]

    assert compact_event.payload["compacted"] is True
    assert compact_event.payload["older_message_count"] > 0
    assert compact_event.payload["recent_message_count"] <= 4
    assert compact_event.payload["important_message_count"] >= 0
    assert compact_event.payload["context_window_tokens"] == 10000
    assert compact_event.payload["compact_threshold_tokens"] == 60
    assert compact_event.payload["estimated_history_tokens"] > compact_event.payload["compact_threshold_tokens"]
    assert compact_event.payload["context_focus"] == "idea_plan"
    assert compact_event.payload["persistent_summary_id"] == summary_event.payload["summary_id"]
    assert compact_event.payload["persistent_summary_path"] == summary_event.payload["path"]

    summary = MemoryManager(workspace).read_conversation_summary(thread.thread_id)
    assert summary is not None
    assert summary.summary_id == summary_event.payload["summary_id"]
    assert summary.covered_message_count == compact_event.payload["older_message_count"]
    assert Path(summary.markdown_path).exists()
    assert Path(summary.metadata_path).exists()

    trace = workspace.get_trace(result.artifact.trace_refs[0])
    payload = TraceRecorder(workspace).read_payload(trace)
    history_context = payload["payload"]["history_context"]
    assert history_context["compacted"] is True
    assert "Persistent conversation summary" in history_context["prompt_text"]
    assert history_context["persistent_summary_id"] == summary.summary_id


def test_history_context_does_not_compact_short_history_by_message_count(tmp_path: Path) -> None:
    workspace = ProjectWorkspace(tmp_path)
    workspace.init()
    thread = workspace.create_thread()
    for index in range(1, 6):
        workspace.add_message(thread.thread_id, "user", f"短消息 {index}: 继续讨论。")
        workspace.add_message(thread.thread_id, "assistant", f"短回复 {index}: 可以。")

    packet = _build_history_context(
        workspace.list_messages(thread.thread_id),
        latest_input="继续讨论 compact 策略",
    )

    assert packet["compacted"] is False
    assert packet["recent_message_count"] == 10
    assert packet["older_message_count"] == 0
    assert packet["compact_reason"].startswith("history fits token budget")


def test_history_context_keeps_important_older_snippets_under_budget(tmp_path: Path) -> None:
    workspace = ProjectWorkspace(tmp_path)
    workspace.init()
    thread = workspace.create_thread()
    workspace.add_message(thread.thread_id, "user", "必须坚持顶会算法创新，不能做工程拼装。")
    workspace.add_message(thread.thread_id, "assistant", "问题：核心机制必须区别于普通 workflow。")
    for index in range(1, 10):
        workspace.add_message(thread.thread_id, "user", f"普通进展 {index}: 继续。")
        workspace.add_message(thread.thread_id, "assistant", f"普通回复 {index}: 收到。")

    packet = _build_history_context(
        workspace.list_messages(thread.thread_id),
        latest_input="继续做 idea plan，检查顶会算法创新约束",
        compaction_config=AgentConfig.load(tmp_path).context_compaction,
        recent_message_limit=4,
        recent_char_limit=400,
    )

    assert packet["compacted"] is True
    assert packet["important_message_count"] >= 1
    assert "High-importance older snippets" in packet["prompt_text"]
    assert "必须坚持顶会算法创新" in packet["prompt_text"]
    assert packet["important_source_refs"][0] == "msg:1"


def test_history_context_redacts_secret_like_values(tmp_path: Path) -> None:
    workspace = ProjectWorkspace(tmp_path)
    workspace.init()
    thread = workspace.create_thread()
    workspace.add_message(thread.thread_id, "user", "api_key=sk-testsecretvalue123456789")

    packet = _build_history_context(workspace.list_messages(thread.thread_id))

    assert "sk-testsecretvalue" not in packet["prompt_text"]
    assert "api_key=[REDACTED]" in packet["prompt_text"]


def test_context_usage_uses_configured_window_and_compact_threshold(tmp_path: Path) -> None:
    workspace = ProjectWorkspace(tmp_path)
    workspace.init()
    (tmp_path / ".academic-agent" / "config.toml").write_text(
        "\n".join(
            [
                "[context.compaction]",
                "context_window_tokens = 8000",
                "max_history_tokens = 1000",
                "compact_trigger_ratio = 0.5",
            ]
        ),
        encoding="utf-8",
    )
    thread = workspace.create_thread()
    workspace.add_message(thread.thread_id, "user", "讨论一个顶会 academic agent idea。")

    usage = build_context_usage(workspace, thread.thread_id, draft_input="继续讨论实验")

    assert usage.context_window_tokens == 8000
    assert usage.history_token_budget == 1000
    assert usage.compact_threshold_tokens == 500
    assert usage.estimated_thread_tokens > 0
    assert usage.estimated_draft_tokens > 0
    assert usage.estimated_total_tokens == usage.estimated_thread_tokens + usage.estimated_draft_tokens


def test_tool_observation_distinguishes_partial_search_errors() -> None:
    success_with_partial_error = _tool_observation_message(
        "paper_search",
        {
            "source": "paper_search",
            "result_count": 2,
            "sources": ["arxiv"],
            "top_titles": ["World Models for Agents"],
            "error_message": "openalex: read operation timed out",
        },
        is_error=False,
    )
    failed = _tool_observation_message(
        "paper_search",
        {
            "source": "paper_search",
            "result_count": 0,
            "sources": [],
            "top_titles": [],
            "error_message": "openalex: read operation timed out",
        },
        is_error=True,
    )

    assert "返回 2 条结果" in success_with_partial_error
    assert "部分来源失败" in success_with_partial_error
    assert "没有成功完成" not in success_with_partial_error
    assert "没有成功完成" in failed


def test_idea_plan_stub_hits_app_cache_on_repeat_run(tmp_path: Path) -> None:
    workspace = ProjectWorkspace(tmp_path)
    runner = IdeaPlanRunner(workspace)

    first = runner.run("Cacheable academic idea")
    second = runner.run("Cacheable academic idea")

    assert first.draft.diagnosis.problem == second.draft.diagnosis.problem
    assert second.run.status == "completed"
    assert len(workspace.list_app_cache_records()) == 1
    second_events = [event.event_type for event in workspace.list_events(second.run.run_id)]
    assert "cache.hit" in second_events


def test_idea_plan_continuation_reuses_thread_artifact_and_opening_once(tmp_path: Path) -> None:
    workspace = ProjectWorkspace(tmp_path)
    runner = IdeaPlanRunner(workspace)

    first = runner.run("A session-scoped academic planning idea")
    second = runner.run(
        "补充：把创新点收窄到读论文时的人机分歧建模。",
        thread_id=first.run.thread_id,
    )

    assert second.run.thread_id == first.run.thread_id
    assert second.artifact.artifact_id == first.artifact.artifact_id
    assert second.artifact.path == first.artifact.path
    assert Path(second.artifact.path).exists()
    assert len(list((tmp_path / ".academic-agent" / "artifacts").glob("*.md"))) == 1

    messages = workspace.list_messages(first.run.thread_id)
    roles = [message.role for message in messages]
    assert roles.count("user") == 2
    assert roles.count("assistant") >= 2
    user_msgs = [m for m in messages if m.role == "user"]
    assert user_msgs[0].content == "A session-scoped academic planning idea"
    assert user_msgs[1].content.startswith("补充：把创新点收窄到读论文时的人机分歧建模")

    second_event_types = [event.event_type for event in workspace.list_events(second.run.run_id)]
    assert "artifact.updated" in second_event_types
    assert "artifact.created" not in second_event_types


@pytest.mark.asyncio
async def test_api_project_run_sse_artifact_and_trace(tmp_path: Path) -> None:
    app = create_app(tmp_path)
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        init_response = await client.post("/projects/init", json={})
        assert init_response.status_code == 200
        assert init_response.json()["initialized"] is True

        profiles_response = await client.get("/providers/profiles")
        assert profiles_response.status_code == 200
        profiles_payload = profiles_response.json()
        assert profiles_payload["profiles"][0]["profile"] == "planner"
        assert profiles_payload["profiles"][0]["provider"] == "mock"

        capabilities_response = await client.get("/capabilities")
        assert capabilities_response.status_code == 200
        assert "run_cancel" in capabilities_response.json()["capabilities"]
        assert "session_artifact_update" in capabilities_response.json()["capabilities"]
        assert "project_memory_map" in capabilities_response.json()["capabilities"]

        run_response = await client.post(
            "/runs/idea-plan",
            json={"idea": "A debate-based academic agent for novelty discovery"},
        )
        assert run_response.status_code == 200
        run_payload = run_response.json()
        run_id = run_payload["run"]["run_id"]
        assert run_payload["run"]["status"] == "created"
        assert run_payload["events_url"] == f"/runs/{run_id}/events"

        events_response = await client.get(f"/runs/{run_id}/events")
        assert events_response.status_code == 200
        sse_text = events_response.text

        assert "event: context.built" in sse_text
        assert "event: activity.started" in sse_text
        assert "event: assistant.delta" in sse_text
        assert "event: assistant.completed" in sse_text
        assert "event: artifact.created" in sse_text
        assert "event: run.completed" in sse_text

        completed_run_response = await client.get(f"/runs/{run_id}")
        assert completed_run_response.status_code == 200
        completed_run = completed_run_response.json()
        assert completed_run["status"] == "completed"
        artifact_id = completed_run["artifact_id"]

        result_response = await client.get(f"/runs/{run_id}/result")
        assert result_response.status_code == 200
        result_payload = result_response.json()
        assert result_payload["draft"]["diagnosis"]["problem"].startswith("用户提出的研究方向")
        assert result_payload["draft"]["diagnosis"]["clarifying_questions"]
        roles = [message["role"] for message in result_payload["messages"]]
        assert "user" in roles
        assert "assistant" in roles
        trace_id = result_payload["artifact"]["trace_refs"][0]
        thread_id = result_payload["run"]["thread_id"]
        assert result_payload["thread"]["thread_id"] == thread_id

        rename_response = await client.post(
            f"/threads/{thread_id}/rename",
            json={"name": "window-inspection"},
        )
        assert rename_response.status_code == 200
        assert rename_response.json()["name"] == "window-inspection"

        lookup_response = await client.get("/threads/by-name/window-inspection")
        assert lookup_response.status_code == 200
        assert lookup_response.json()["thread_id"] == thread_id

        messages_response = await client.get(f"/threads/{thread_id}/messages")
        assert messages_response.status_code == 200
        messages_payload = messages_response.json()
        assert messages_payload["thread"]["name"] == "window-inspection"
        assert len(messages_payload["messages"]) >= 2

        memory_response = await client.get("/memory/map")
        assert memory_response.status_code == 200
        memory_payload = memory_response.json()
        assert "## Current Research State" in memory_payload["content"]
        assert memory_payload["memory_map"]["record_count"] >= 1
        assert any(
            record["record_type"] == "current_plan"
            for record in memory_payload["memory_map"]["records"]
        )

        memory_search_response = await client.get(
            "/memory/search",
            params={"q": "几何一致性机制", "thread_id": thread_id},
        )
        assert memory_search_response.status_code == 200
        assert memory_search_response.json()["results"]

        usage_response = await client.get(
            f"/threads/{thread_id}/context-usage",
            params={"draft": "继续讨论实验设计"},
        )
        assert usage_response.status_code == 200
        usage_payload = usage_response.json()
        assert usage_payload["thread_id"] == thread_id
        assert usage_payload["estimated_total_tokens"] >= usage_payload["estimated_thread_tokens"]
        assert usage_payload["compact_threshold_tokens"] > 0

        continue_response = await client.post(
            f"/threads/{thread_id}/idea-plan",
            json={
                "content": (
                    "补充：目标窗户由楼层和列号给出，核心创新希望落在几何一致性机制。"
                )
            },
        )
        assert continue_response.status_code == 200
        second_run_id = continue_response.json()["run"]["run_id"]
        assert continue_response.json()["run"]["thread_id"] == thread_id

        second_events_response = await client.get(f"/runs/{second_run_id}/events")
        assert second_events_response.status_code == 200
        assert "event: run.completed" in second_events_response.text

        second_result_response = await client.get(f"/runs/{second_run_id}/result")
        assert second_result_response.status_code == 200
        second_result = second_result_response.json()
        assert second_result["run"]["thread_id"] == thread_id
        assert second_result["run"]["artifact_id"] == artifact_id
        assert second_result["artifact"]["artifact_id"] == artifact_id
        assert second_result["thread"]["name"] == "window-inspection"
        assert len(second_result["messages"]) >= 4
        assert any(msg["content"].startswith("补充：目标窗户") for msg in second_result["messages"])

        artifact_response = await client.get(f"/artifacts/{artifact_id}")
        assert artifact_response.status_code == 200
        assert "## Evidence Needed" in artifact_response.json()["content"]

        plan_response = await client.get(f"/threads/{thread_id}/plan")
        assert plan_response.status_code == 200
        plan_payload = plan_response.json()
        assert plan_payload["session_status"] == "draft"
        assert plan_payload["artifact"]["artifact_id"] == artifact_id
        assert plan_payload["draft"]["diagnosis"]["main_uncertainty"]

        review_response = await client.post(
            f"/threads/{thread_id}/review",
            json={"decision": "Revise", "notes": "Need stronger literature evidence."},
        )
        assert review_response.status_code == 200
        assert review_response.json()["decision"] == "Revise"
        assert review_response.json()["session_status"] == "reviewed"

        reviewed_plan_response = await client.get(f"/threads/{thread_id}/plan")
        assert reviewed_plan_response.status_code == 200
        assert reviewed_plan_response.json()["session_status"] == "reviewed"

        reviewed_memory_response = await client.post("/memory/rebuild")
        assert reviewed_memory_response.status_code == 200
        assert any(
            record["record_type"] == "idea_review"
            for record in reviewed_memory_response.json()["memory_map"]["records"]
        )

        freeze_response = await client.post(f"/threads/{thread_id}/freeze", json={})
        assert freeze_response.status_code == 200
        freeze_payload = freeze_response.json()
        assert freeze_payload["artifact"]["artifact_type"] == "ResearchIdeaPlan"
        assert freeze_payload["artifact"]["status"] == "frozen"
        assert freeze_payload["plan"]["source_draft_artifact_id"] == artifact_id

        frozen_plan_response = await client.get(f"/threads/{thread_id}/plan")
        assert frozen_plan_response.status_code == 200
        assert frozen_plan_response.json()["session_status"] == "frozen"

        conflicts_response = await client.get("/memory/conflicts", params={"thread_id": thread_id})
        assert conflicts_response.status_code == 200
        assert any(
            conflict["conflict_type"] == "freeze_gate_conflict"
            for conflict in conflicts_response.json()["conflicts"]
        )

        recheck_response = await client.post("/memory/recheck")
        assert recheck_response.status_code == 200
        assert recheck_response.json()["memory_map"]["record_count"] >= 1

        trace_response = await client.get(f"/traces/{trace_id}")
        assert trace_response.status_code == 200
        assert trace_response.json()["trace"]["trace_id"] == trace_id

        list_response = await client.get("/runs")
        assert list_response.status_code == 200
        listed_run_ids = [run["run_id"] for run in list_response.json()["runs"]]
        assert second_run_id in listed_run_ids
        assert run_id in listed_run_ids


@pytest.mark.asyncio
async def test_api_lists_and_clears_app_cache(tmp_path: Path) -> None:
    app = create_app(tmp_path)
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        await client.post("/projects/init", json={})
        run_response = await client.post(
            "/runs/idea-plan",
            json={"idea": "Cache inspection idea"},
        )
        run_id = run_response.json()["run"]["run_id"]
        events_response = await client.get(f"/runs/{run_id}/events")
        assert events_response.status_code == 200

        list_response = await client.get("/cache")
        assert list_response.status_code == 200
        records = list_response.json()["records"]
        assert len(records) >= 1

        clear_response = await client.delete("/cache")
        assert clear_response.status_code == 200
        assert clear_response.json()["deleted"] >= 0

        empty_response = await client.get("/cache")
        assert empty_response.status_code == 200
        assert empty_response.json()["records"] == []


@pytest.mark.asyncio
async def test_api_paper_search_endpoint_uses_local_search_tool(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeSearchEngine:
        def paper_search(
            self,
            query: str,
            max_results: int = 8,
            sources: list[str] | None = None,
            sort_by: str = "hybrid",
        ) -> SearchResponse:
            return SearchResponse(
                query=query,
                source="paper_search",
                retrieved_at=utc_now(),
                results=[
                    SearchResult(
                        source="arxiv",
                        title=f"{query} paper",
                        snippet="A mocked paper search result.",
                        url="https://arxiv.org/abs/2401.00001",
                        retrieved_at=utc_now(),
                        external_id="2401.00001",
                        metadata={
                            "max_results": max_results,
                            "sources": sources or [],
                            "sort_by": sort_by,
                        },
                    )
                ],
            )

    monkeypatch.setattr(
        "academic_agent_core.api.create_default_search_engine",
        lambda *args, **kwargs: FakeSearchEngine(),
    )
    app = create_app(tmp_path)
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        capabilities_response = await client.get("/capabilities")
        assert "paper_search_tool" in capabilities_response.json()["capabilities"]

        providers_response = await client.get("/search/providers")
        assert providers_response.status_code == 200
        providers_payload = providers_response.json()
        assert providers_payload["paper_sources"] == ["arxiv", "openalex"]
        assert "brave" in providers_payload["web_sources"]
        assert "has_api_key" in providers_payload["providers"][0]

        search_response = await client.post(
            "/search/papers",
            json={
                "query": "academic agent",
                "max_results": 3,
                "sources": ["arxiv"],
                "sort_by": "submitted_date",
            },
        )

    assert search_response.status_code == 200
    payload = search_response.json()
    assert payload["source"] == "paper_search"
    assert payload["results"][0]["title"] == "academic agent paper"
    assert payload["results"][0]["metadata"]["max_results"] == 3
    assert payload["results"][0]["metadata"]["sources"] == ["arxiv"]
    assert payload["results"][0]["metadata"]["sort_by"] == "submitted_date"


@pytest.mark.asyncio
async def test_api_can_cancel_created_run(tmp_path: Path) -> None:
    app = create_app(tmp_path)
    app.state.workspace.init()
    run = IdeaPlanRunner(app.state.workspace).create_run("Cancel this idea plan run")
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        cancel_response = await client.post(f"/runs/{run.run_id}/cancel", json={})
        assert cancel_response.status_code == 200
        assert cancel_response.json()["status"] == "cancelled"

        events_response = await client.get(f"/runs/{run.run_id}/events")
        assert events_response.status_code == 200
        assert "event: run.cancelled" in events_response.text

        result_response = await client.get(f"/runs/{run.run_id}/result")
        assert result_response.status_code == 409


@pytest.mark.asyncio
async def test_api_thread_list_excludes_empty_threads(tmp_path: Path) -> None:
    app = create_app(tmp_path)
    app.state.workspace.init()
    empty_thread = app.state.workspace.create_thread()
    orphaned_run = app.state.workspace.create_run(empty_thread.thread_id, "legacy orphaned run")
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        run_response = await client.post(
            "/runs/idea-plan",
            json={"idea": "A recoverable session"},
        )
        run_id = run_response.json()["run"]["run_id"]
        events_response = await client.get(f"/runs/{run_id}/events")
        assert events_response.status_code == 200

        threads_response = await client.get("/threads")
        assert threads_response.status_code == 200
        thread_ids = [thread["thread_id"] for thread in threads_response.json()["threads"]]
        assert run_response.json()["run"]["thread_id"] in thread_ids
        assert empty_thread.thread_id not in thread_ids
        latest_run_ids = [thread["latest_run_id"] for thread in threads_response.json()["threads"]]
        assert orphaned_run.run_id not in latest_run_ids
        session = threads_response.json()["threads"][0]
        assert session["title"] == "A recoverable session"
        assert session["message_count"] >= 2
        assert session["updated_at"]
        assert session["latest_run_id"] == run_id
        assert session["latest_status"] == "completed"


# ---------------------------------------------------------------------------
# DeepSeek provider tests
# ---------------------------------------------------------------------------


def test_deepseek_provider_defaults_and_factory_registration() -> None:
    config = ProviderProfileConfig(
        profile="planner",
        provider="deepseek",
        model="deepseek-chat",
        api_key_env="DEEPSEEK_API_KEY",
        base_url="https://api.deepseek.com",
    )
    env = {"DEEPSEEK_API_KEY": "sk-test-secret"}
    provider = create_idea_diagnosis_provider(config, env)
    assert provider.config.provider == "deepseek"
    assert provider.config.model == "deepseek-chat"
    assert provider.config.base_url == "https://api.deepseek.com"


def test_deepseek_provider_respects_live_gate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test-secret")
    monkeypatch.delenv("ACADEMIC_AGENT_ENABLE_LIVE_PROVIDERS", raising=False)
    monkeypatch.delenv("ACADEMIC_AGENT_PROVIDER", raising=False)

    workspace = ProjectWorkspace(tmp_path)
    workspace.init()
    (tmp_path / ".academic-agent" / "config.toml").write_text(
        "\n".join([
            "[providers.planner]",
            'provider = "deepseek"',
            'model = "deepseek-chat"',
            'api_key_env = "DEEPSEEK_API_KEY"',
        ]),
        encoding="utf-8",
    )

    config = AgentConfig.load(tmp_path)
    status = [item for item in config.statuses() if item.profile == "planner"][0]

    assert status.provider == "deepseek"
    assert status.model == "deepseek-chat"
    assert status.has_api_key is True
    assert status.live_enabled is False
    assert status.will_use_live is False


def test_deepseek_provider_with_live_gate_enabled(tmp_path: Path) -> None:
    workspace = ProjectWorkspace(tmp_path)
    workspace.init()
    (tmp_path / ".academic-agent" / "config.toml").write_text(
        "\n".join([
            "[providers.planner]",
            'provider = "deepseek"',
            'model = "deepseek-chat"',
            'api_key_env = "DEEPSEEK_API_KEY"',
        ]),
        encoding="utf-8",
    )
    env = {"DEEPSEEK_API_KEY": "sk-test-secret", "ACADEMIC_AGENT_ENABLE_LIVE_PROVIDERS": "1"}

    config = AgentConfig.load(tmp_path, env=env)
    status = [item for item in config.statuses() if item.profile == "planner"][0]

    assert status.will_use_live is True


def test_deepseek_usage_normalizer_surfaces_context_cache_hit_tokens() -> None:
    usage = {
        "prompt_tokens": 1200,
        "completion_tokens": 80,
        "total_tokens": 1280,
        "prompt_cache_hit_tokens": 900,
        "prompt_cache_miss_tokens": 300,
    }

    normalized = _normalize_deepseek_usage(usage)

    assert normalized["cache_read_tokens"] == 900
    assert normalized["prompt_cache_hit_tokens"] == 900
    assert normalized["prompt_cache_miss_tokens"] == 300
    assert normalized["input_tokens"] == 1200
    assert normalized["output_tokens"] == 80


def test_deepseek_usage_normalizer_handles_full_cache_miss() -> None:
    usage = {
        "prompt_tokens": 500,
        "completion_tokens": 120,
        "total_tokens": 620,
        "prompt_cache_hit_tokens": 0,
        "prompt_cache_miss_tokens": 500,
    }

    normalized = _normalize_deepseek_usage(usage)

    assert normalized["cache_read_tokens"] == 0
    assert normalized["prompt_cache_hit_tokens"] == 0
    assert normalized["prompt_cache_miss_tokens"] == 500
    assert _deepseek_context_cache_hit(usage) is False


def test_deepseek_context_cache_hit_detection() -> None:
    assert _deepseek_context_cache_hit({"prompt_cache_hit_tokens": 800}) is True
    assert _deepseek_context_cache_hit({"prompt_cache_hit_tokens": 0}) is False
    assert _deepseek_context_cache_hit({}) is False


def test_deepseek_provider_build_request_hash_is_stable_across_runs() -> None:
    config = ProviderProfileConfig(
        profile="planner",
        provider="deepseek",
        model="deepseek-chat",
        api_key_env="DEEPSEEK_API_KEY",
        base_url="https://api.deepseek.com",
    )
    env = {"DEEPSEEK_API_KEY": "sk-test-secret"}

    provider = create_idea_diagnosis_provider(config, env)

    request_a = provider.build_request("cache-me", "ctx_a")
    request_b = provider.build_request("cache-me", "ctx_b")

    assert request_a.input_hash == request_b.input_hash
    assert request_a.provider == "deepseek"
    assert request_a.model == "deepseek-chat"


def test_deepseek_provider_cache_isolation_by_history() -> None:
    config = ProviderProfileConfig(
        profile="planner",
        provider="deepseek",
        model="deepseek-chat",
        api_key_env="DEEPSEEK_API_KEY",
        base_url="https://api.deepseek.com",
    )
    env = {"DEEPSEEK_API_KEY": "sk-test-secret"}

    provider = create_idea_diagnosis_provider(config, env)

    request_no_history = provider.build_request("same idea", "ctx_1")
    history = [
        ThreadMessage(
            message_id="msg_1",
            thread_id="thread",
            role="user",
            content="prior turn",
            run_id="run1",
            created_at="t1",
            ordinal=1,
        )
    ]
    request_with_history = provider.build_request("same idea", "ctx_2", history)

    assert request_no_history.input_hash != request_with_history.input_hash
    assert request_no_history.provider == request_with_history.provider
    assert request_no_history.model == request_with_history.model
