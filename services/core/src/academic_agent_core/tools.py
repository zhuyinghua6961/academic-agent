from __future__ import annotations

from typing import Any, Protocol, cast

from .search import SearchEngine, create_default_search_engine
from .schemas import PaperSearchSort, SearchSource, ToolDefinition


class ToolExecutor(Protocol):
    definition: ToolDefinition

    def execute(self, arguments: dict[str, Any]) -> dict[str, Any]:
        ...


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolExecutor] = {}

    def register(self, executor: ToolExecutor) -> None:
        self._tools[executor.definition.name] = executor

    def get_all_definitions(self) -> list[dict[str, Any]]:
        """Return OpenAI-format tool definitions for the API request."""
        return [
            {
                "type": "function",
                "function": {
                    "name": executor.definition.name,
                    "description": executor.definition.description,
                    "parameters": executor.definition.parameters,
                },
            }
            for executor in self._tools.values()
        ]

    def execute(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        executor = self._tools.get(name)
        if executor is None:
            return {"error": f"Unknown tool: {name}"}
        try:
            return executor.execute(arguments)
        except Exception as exc:
            return {"error": str(exc)}

    def __len__(self) -> int:
        return len(self._tools)


class WebSearchTool:
    def __init__(self, search_engine: SearchEngine) -> None:
        self.search_engine = search_engine
        self.definition = ToolDefinition(
            name="web_search",
            description=(
                "Search the open web for technical information. This is a fallback "
                "tool; use paper_search first when the task is about academic literature."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query. Use academic terminology.",
                    },
                    "max_results": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 10,
                        "description": "Maximum number of results to return.",
                    },
                },
                "required": ["query"],
            },
        )

    def execute(self, arguments: dict[str, Any]) -> dict[str, Any]:
        query = arguments.get("query", "")
        if not query.strip():
            return {"error": "Empty query", "results": []}
        max_results = _bounded_int(arguments.get("max_results"), default=8, lower=1, upper=10)
        response = self.search_engine.web_search(query, max_results=max_results)
        return response.model_dump(mode="json")


class PaperSearchTool:
    def __init__(self, search_engine: SearchEngine) -> None:
        self.search_engine = search_engine
        self.definition = ToolDefinition(
            name="paper_search",
            description=(
                "Search academic literature for related work and nearby papers. "
                "Use this before web_search when diagnosing novelty or research gaps. "
                "Returns structured paper metadata, abstracts/snippets, URLs, and source names."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Academic query using task, method, or problem keywords.",
                    },
                    "max_results": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 10,
                        "description": "Maximum number of papers to return.",
                    },
                    "sources": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": [
                                "arxiv",
                                "openalex",
                                "brave",
                                "tavily",
                                "serper",
                                "serpapi",
                                "duckduckgo",
                            ],
                        },
                        "description": (
                            "Search sources in priority order. Defaults to arxiv, openalex, then web."
                        ),
                    },
                    "sort_by": {
                        "type": "string",
                        "enum": ["hybrid", "relevance", "submitted_date"],
                        "description": (
                            "Paper ordering strategy. Use hybrid by default so arXiv returns both "
                            "relevant papers and newly submitted preprints. Use submitted_date "
                            "when the user asks for latest/recent/current preprints."
                        ),
                    },
                },
                "required": ["query"],
            },
        )

    def execute(self, arguments: dict[str, Any]) -> dict[str, Any]:
        query = arguments.get("query", "")
        if not query.strip():
            return {"error": "Empty query", "results": []}
        max_results = _bounded_int(arguments.get("max_results"), default=8, lower=1, upper=10)
        sources = _search_sources(arguments.get("sources"))
        sort_by = _paper_search_sort(arguments.get("sort_by"))
        response = self.search_engine.paper_search(
            query,
            max_results=max_results,
            sources=sources,
            sort_by=sort_by,
        )
        return response.model_dump(mode="json")


def get_default_tools(search_engine: SearchEngine | None = None) -> ToolRegistry:
    search_engine = search_engine or create_default_search_engine()
    registry = ToolRegistry()
    registry.register(PaperSearchTool(search_engine))
    registry.register(WebSearchTool(search_engine))
    return registry


def _bounded_int(value: Any, default: int, lower: int, upper: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(lower, min(parsed, upper))


def _search_sources(value: Any) -> list[SearchSource] | None:
    if not isinstance(value, list):
        return None
    sources = [
        cast(SearchSource, item)
        for item in value
        if item in {"arxiv", "openalex", "brave", "tavily", "serper", "serpapi", "duckduckgo"}
    ]
    return sources or None


def _paper_search_sort(value: Any) -> PaperSearchSort:
    if value == "relevance":
        return "relevance"
    if value == "submitted_date":
        return "submitted_date"
    return "hybrid"
