from __future__ import annotations

import os
import tomllib
from pathlib import Path
from typing import Any, Mapping

from dotenv import dotenv_values

from .schemas import (
    ProviderName,
    ProviderProfileConfig,
    ProviderProfileName,
    ProviderProfileStatus,
    SearchSource,
)


PROFILE_NAMES: tuple[ProviderProfileName, ...] = (
    "planner",
    "reviewer",
    "writer",
    "extractor",
    "embedder",
)

DEFAULT_MODELS: dict[ProviderName, str] = {
    "mock": "mock-idea-diagnoser-v0",
    "openai": "gpt-4.1-mini",
    "anthropic": "claude-3-5-haiku-latest",
    "openai_compatible": "local-openai-compatible-model",
    "deepseek": "deepseek-chat",
}

DEFAULT_API_KEY_ENVS: dict[ProviderName, str | None] = {
    "mock": None,
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "openai_compatible": "ACADEMIC_AGENT_OPENAI_COMPATIBLE_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
}

DEFAULT_BASE_URLS: dict[ProviderName, str | None] = {
    "mock": None,
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com",
    "openai_compatible": "http://127.0.0.1:8000/v1",
    "deepseek": "https://api.deepseek.com",
}

DEFAULT_SEARCH_API_KEY_ENVS: dict[SearchSource, str | None] = {
    "arxiv": None,
    "openalex": None,
    "brave": "BRAVE_SEARCH_API_KEY",
    "tavily": "TAVILY_API_KEY",
    "serper": "SERPER_API_KEY",
    "serpapi": "SERPAPI_API_KEY",
    "duckduckgo": None,
}

DEFAULT_SEARCH_BASE_URLS: dict[SearchSource, str | None] = {
    "arxiv": "https://export.arxiv.org/api/query",
    "openalex": "https://api.openalex.org/works",
    "brave": "https://api.search.brave.com/res/v1/web/search",
    "tavily": "https://api.tavily.com/search",
    "serper": "https://google.serper.dev/search",
    "serpapi": "https://serpapi.com/search.json",
    "duckduckgo": None,
}


class SearchProviderConfig:
    def __init__(
        self,
        source: SearchSource,
        api_key_env: str | None,
        base_url: str | None,
        enabled: bool = True,
    ) -> None:
        self.source = source
        self.api_key_env = api_key_env
        self.base_url = base_url
        self.enabled = enabled


class SearchConfig:
    def __init__(
        self,
        paper_sources: list[SearchSource],
        web_sources: list[SearchSource],
        providers: dict[SearchSource, SearchProviderConfig],
        timeout_seconds: float = 30.0,
        trust_env: bool = True,
    ) -> None:
        self.paper_sources = paper_sources
        self.web_sources = web_sources
        self.providers = providers
        self.timeout_seconds = timeout_seconds
        self.trust_env = trust_env


class ContextCompactionConfig:
    def __init__(
        self,
        enabled: bool = True,
        context_window_tokens: int | None = None,
        model_context_tokens: int | None = None,
        compact_trigger_ratio: float = 0.85,
        max_history_tokens: int = 2400,
        response_token_reserve: int = 1600,
        system_tool_token_reserve: int = 2600,
        chars_per_token: float = 4.0,
        min_recent_messages: int = 4,
        max_recent_messages: int = 16,
        recent_token_ratio: float = 0.55,
        important_message_limit: int = 6,
        important_token_ratio: float = 0.25,
        summary_token_ratio: float = 0.35,
        per_message_token_limit: int = 240,
        artifact_token_ratio: float = 0.20,
        artifact_max_tokens: int = 4000,
        paper_evidence_limit: int = 3,
    ) -> None:
        resolved_context_window_tokens = context_window_tokens or model_context_tokens
        self.enabled = enabled
        self.context_window_tokens = resolved_context_window_tokens
        self.model_context_tokens = resolved_context_window_tokens
        self.compact_trigger_ratio = compact_trigger_ratio
        self.max_history_tokens = max_history_tokens
        self.response_token_reserve = response_token_reserve
        self.system_tool_token_reserve = system_tool_token_reserve
        self.chars_per_token = chars_per_token
        self.min_recent_messages = min_recent_messages
        self.max_recent_messages = max_recent_messages
        self.recent_token_ratio = recent_token_ratio
        self.important_message_limit = important_message_limit
        self.important_token_ratio = important_token_ratio
        self.summary_token_ratio = summary_token_ratio
        self.per_message_token_limit = per_message_token_limit
        self.artifact_token_ratio = artifact_token_ratio
        self.artifact_max_tokens = artifact_max_tokens
        self.paper_evidence_limit = paper_evidence_limit


class MemoryConfig:
    def __init__(
        self,
        retrieval_limit: int = 8,
        vector_dimensions: int = 96,
        paper_evidence_ttl_days: int = 30,
        stale_recheck_enabled: bool = True,
        conflict_detection_enabled: bool = True,
    ) -> None:
        self.retrieval_limit = retrieval_limit
        self.vector_dimensions = vector_dimensions
        self.paper_evidence_ttl_days = paper_evidence_ttl_days
        self.stale_recheck_enabled = stale_recheck_enabled
        self.conflict_detection_enabled = conflict_detection_enabled


def live_providers_enabled(env: Mapping[str, str] | None = None) -> bool:
    source = env if env is not None else os.environ
    value = source.get("ACADEMIC_AGENT_ENABLE_LIVE_PROVIDERS", "")
    return value.lower() in {"1", "true", "yes", "on"}


def mock_provider_allowed(env: Mapping[str, str]) -> bool:
    value = env.get("ACADEMIC_AGENT_ALLOW_MOCK", "")
    return value.lower() in {"1", "true", "yes", "on"}


class ConfigurationRequiredError(RuntimeError):
    code = "configuration_required"

    def __init__(self, message: str = "Provider configuration required") -> None:
        super().__init__(message)


class AgentConfig:
    def __init__(
        self,
        profiles: dict[ProviderProfileName, ProviderProfileConfig],
        search: SearchConfig,
        context_compaction: ContextCompactionConfig,
        memory: MemoryConfig,
        sources: list[str],
        env: dict[str, str] | None = None,
    ) -> None:
        self.profiles = profiles
        self.search = search
        self.context_compaction = context_compaction
        self.memory = memory
        self.sources = sources
        self.env = dict(env if env is not None else os.environ)

    @classmethod
    def load(cls, project_root: Path | str, env: dict[str, str] | None = None) -> "AgentConfig":
        project_root_path = Path(project_root)
        source_env = _load_env(project_root_path, env)
        sources: list[str] = []
        raw_profiles: dict[str, dict[str, Any]] = {}
        raw_search: dict[str, Any] = {}
        raw_context: dict[str, Any] = {}
        raw_memory: dict[str, Any] = {}

        for config_path in _config_paths(project_root_path, source_env):
            if config_path.exists():
                data = tomllib.loads(config_path.read_text(encoding="utf-8"))
                sources.append(str(config_path))
                for name, payload in data.get("providers", {}).items():
                    if isinstance(payload, dict):
                        raw_profiles[name] = {**raw_profiles.get(name, {}), **payload}
                if isinstance(data.get("search"), dict):
                    raw_search = _deep_merge(raw_search, data["search"])
                if isinstance(data.get("context"), dict):
                    raw_context = _deep_merge(raw_context, data["context"])
                if isinstance(data.get("memory"), dict):
                    raw_memory = _deep_merge(raw_memory, data["memory"])

        profiles = _default_profiles(include_planner=False)
        for name, payload in raw_profiles.items():
            if name in PROFILE_NAMES:
                profile = _profile_from_payload(name, payload)
                if profile.provider != "mock" or mock_provider_allowed(source_env):
                    profiles[name] = profile

        if "planner" not in profiles and mock_provider_allowed(source_env):
            profiles["planner"] = _mock_profile("planner")

        _apply_env_overrides(profiles, source_env)
        return cls(
            profiles=profiles,
            search=_search_config_from_raw(raw_search),
            context_compaction=_context_compaction_from_raw(raw_context),
            memory=_memory_config_from_raw(raw_memory),
            sources=sources,
            env=source_env,
        )

    def profile(self, name: ProviderProfileName) -> ProviderProfileConfig:
        try:
            return self.profiles[name]
        except KeyError as exc:
            raise ConfigurationRequiredError(
                f"configuration required for provider profile: {name}"
            ) from exc

    def planner_or_none(self) -> ProviderProfileConfig | None:
        return self.profiles.get("planner")

    def setup_state(self) -> str:
        planner = self.planner_or_none()
        if planner is None:
            return "unconfigured"
        if planner.provider == "mock":
            return "configured" if mock_provider_allowed(self.env) else "unconfigured"
        has_key = bool(planner.api_key_env and self.env.get(planner.api_key_env))
        if not has_key or not live_providers_enabled(self.env):
            return "invalid"
        if planner.provider == "openai_compatible" and not planner.base_url:
            return "invalid"
        return "configured"

    def statuses(self) -> list[ProviderProfileStatus]:
        live_enabled = live_providers_enabled(self.env)
        statuses: list[ProviderProfileStatus] = []
        for profile_name in PROFILE_NAMES:
            config = self.profiles.get(profile_name)
            if config is None:
                continue
            has_api_key = bool(config.api_key_env and self.env.get(config.api_key_env))
            statuses.append(
                ProviderProfileStatus(
                    profile=config.profile,
                    provider=config.provider,
                    model=config.model,
                    api_key_env=config.api_key_env,
                    has_api_key=has_api_key,
                    base_url=config.base_url,
                    reasoning_effort=config.reasoning_effort,
                    reasoning_summary=config.reasoning_summary,
                    live_enabled=live_enabled,
                    will_use_live=config.provider != "mock" and live_enabled and has_api_key,
                )
            )
        return statuses


def render_default_project_config() -> str:
    return (
        "# Academic Agent project config\n"
        "# Configure the planner through the first-run setup. Secrets stay in env files.\n\n"
        "[runtime]\n"
        'core_host = "127.0.0.1"\n'
        "core_port = 8765\n\n"
        "[context.compaction]\n"
        "enabled = true\n"
        "# Leave context_window_tokens unset or 0 to infer a conservative model window.\n"
        "context_window_tokens = 0\n"
        "# Compact thread history when estimated history tokens pass this ratio of the history budget.\n"
        "compact_trigger_ratio = 0.85\n"
        "# Max token budget for thread history after reserving system/tool/output budget.\n"
        "max_history_tokens = 2400\n"
        "response_token_reserve = 1600\n"
        "system_tool_token_reserve = 2600\n"
        "chars_per_token = 4.0\n"
        "min_recent_messages = 4\n"
        "max_recent_messages = 16\n"
        "recent_token_ratio = 0.55\n"
        "important_message_limit = 6\n"
        "important_token_ratio = 0.25\n"
        "summary_token_ratio = 0.35\n"
        "per_message_token_limit = 240\n\n"
        "# Artifact-first memory context: current plan/review/evidence is injected before chat history.\n"
        "artifact_token_ratio = 0.20\n"
        "artifact_max_tokens = 4000\n"
        "paper_evidence_limit = 3\n\n"
        "[memory]\n"
        "retrieval_limit = 8\n"
        "vector_dimensions = 96\n"
        "paper_evidence_ttl_days = 30\n"
        "stale_recheck_enabled = true\n"
        "conflict_detection_enabled = true\n\n"
        "# Example OpenAI planner profile:\n"
        "# [providers.planner]\n"
        '# provider = "openai"\n'
        '# model = "gpt-5.1"\n'
        '# api_key_env = "OPENAI_API_KEY"\n'
        '# base_url = "https://api.openai.com/v1"\n'
        '# max_output_tokens = 3000\n'
        '# reasoning_effort = "medium"\n'
        '# reasoning_summary = "auto"\n'
        "#\n"
        "# Example OpenAI-compatible planner profile, such as a local gateway,\n"
        "# vLLM server, LiteLLM proxy, or another /chat/completions-compatible endpoint:\n"
        "# [providers.planner]\n"
        '# provider = "openai_compatible"\n'
        '# model = "your-model-name"\n'
        '# api_key_env = "ACADEMIC_AGENT_OPENAI_COMPATIBLE_API_KEY"\n'
        '# base_url = "http://127.0.0.1:8000/v1"\n'
        "#\n"
        "# You can also override planner provider settings with env vars:\n"
        "# ACADEMIC_AGENT_PROVIDER, ACADEMIC_AGENT_MODEL,\n"
        "# ACADEMIC_AGENT_BASE_URL, ACADEMIC_AGENT_API_KEY_ENV,\n"
        "# ACADEMIC_AGENT_REASONING_EFFORT, ACADEMIC_AGENT_REASONING_SUMMARY.\n"
        "\n[search]\n"
        'paper_sources = ["arxiv", "openalex"]\n'
        'web_sources = ["brave", "tavily", "serper", "serpapi", "duckduckgo"]\n'
        "timeout_seconds = 30\n"
        "trust_env = true\n\n"
        "[search.brave]\n"
        'api_key_env = "BRAVE_SEARCH_API_KEY"\n'
        'base_url = "https://api.search.brave.com/res/v1/web/search"\n\n'
        "[search.tavily]\n"
        'api_key_env = "TAVILY_API_KEY"\n'
        'base_url = "https://api.tavily.com/search"\n\n'
        "[search.serper]\n"
        'api_key_env = "SERPER_API_KEY"\n'
        'base_url = "https://google.serper.dev/search"\n\n'
        "[search.serpapi]\n"
        'api_key_env = "SERPAPI_API_KEY"\n'
        'base_url = "https://serpapi.com/search.json"\n'
    )


def _config_paths(project_root: Path, env: dict[str, str]) -> list[Path]:
    paths: list[Path] = []
    home = env.get("HOME")
    if home:
        paths.append(Path(home) / ".academic-agent" / "config.toml")
    paths.append(project_root / ".academic-agent" / "config.toml")
    explicit = env.get("ACADEMIC_AGENT_CONFIG")
    if explicit:
        paths.append(Path(explicit))
    return paths


def _load_env(project_root: Path, env: dict[str, str] | None) -> dict[str, str]:
    process_env = dict(env if env is not None else os.environ)
    merged: dict[str, str] = {}
    home = process_env.get("HOME")
    env_paths = []
    if home:
        env_paths.append(Path(home) / ".academic-agent" / ".env")
    env_paths.extend((project_root / ".env", project_root / ".academic-agent" / ".env"))
    for env_path in env_paths:
        if env_path.exists():
            for key, value in dotenv_values(env_path).items():
                if value is not None:
                    merged[key] = value
    merged.update(process_env)
    return merged


def _mock_profile(profile: ProviderProfileName) -> ProviderProfileConfig:
    return ProviderProfileConfig(
        profile=profile,
        provider="mock",
        model=DEFAULT_MODELS["mock"],
        api_key_env=None,
        base_url=None,
    )


def _default_profiles(
    *, include_planner: bool = True
) -> dict[ProviderProfileName, ProviderProfileConfig]:
    return {
        profile: _mock_profile(profile)
        for profile in PROFILE_NAMES
        if include_planner or profile != "planner"
    }


def _profile_from_payload(
    profile_name: ProviderProfileName,
    payload: dict[str, Any],
) -> ProviderProfileConfig:
    provider = payload.get("provider", "mock")
    current = {
        "profile": profile_name,
        "provider": provider,
        "model": DEFAULT_MODELS.get(provider, DEFAULT_MODELS["mock"]),
        "api_key_env": DEFAULT_API_KEY_ENVS.get(provider),
        "base_url": DEFAULT_BASE_URLS.get(provider),
    }
    current.update(payload)
    current["profile"] = profile_name
    return ProviderProfileConfig.model_validate(current)


def _default_search_providers() -> dict[SearchSource, SearchProviderConfig]:
    return {
        source: SearchProviderConfig(
            source=source,
            api_key_env=DEFAULT_SEARCH_API_KEY_ENVS[source],
            base_url=DEFAULT_SEARCH_BASE_URLS[source],
            enabled=True,
        )
        for source in DEFAULT_SEARCH_API_KEY_ENVS
    }


def _search_config_from_raw(raw_search: dict[str, Any]) -> SearchConfig:
    providers = _default_search_providers()
    paper_sources = _search_source_list(raw_search.get("paper_sources"), ["arxiv", "openalex"])
    web_sources = _search_source_list(
        raw_search.get("web_sources"),
        ["brave", "tavily", "serper", "serpapi", "duckduckgo"],
    )
    timeout_seconds = float(raw_search.get("timeout_seconds", 30.0))
    trust_env = bool(raw_search.get("trust_env", True))

    for source, provider in list(providers.items()):
        payload = raw_search.get(source)
        if not isinstance(payload, dict):
            continue
        provider.api_key_env = _optional_str(payload.get("api_key_env"), provider.api_key_env)
        provider.base_url = _optional_str(payload.get("base_url"), provider.base_url)
        if "enabled" in payload:
            provider.enabled = bool(payload["enabled"])

    return SearchConfig(
        paper_sources=paper_sources,
        web_sources=web_sources,
        providers=providers,
        timeout_seconds=timeout_seconds,
        trust_env=trust_env,
    )


def _context_compaction_from_raw(raw_context: dict[str, Any]) -> ContextCompactionConfig:
    raw_compaction = raw_context.get("compaction")
    compaction = raw_compaction if isinstance(raw_compaction, dict) else {}
    context_window_tokens = _positive_optional_int(compaction.get("context_window_tokens"))
    model_context_tokens = _positive_optional_int(compaction.get("model_context_tokens"))
    return ContextCompactionConfig(
        enabled=bool(compaction.get("enabled", True)),
        context_window_tokens=context_window_tokens,
        model_context_tokens=model_context_tokens,
        compact_trigger_ratio=_ratio_value(compaction.get("compact_trigger_ratio"), 0.85),
        max_history_tokens=_positive_int(compaction.get("max_history_tokens"), 2400),
        response_token_reserve=_positive_int(compaction.get("response_token_reserve"), 1600),
        system_tool_token_reserve=_positive_int(
            compaction.get("system_tool_token_reserve"),
            2600,
        ),
        chars_per_token=max(1.0, _float_value(compaction.get("chars_per_token"), 4.0)),
        min_recent_messages=_positive_int(compaction.get("min_recent_messages"), 4),
        max_recent_messages=_positive_int(compaction.get("max_recent_messages"), 16),
        recent_token_ratio=_ratio_value(compaction.get("recent_token_ratio"), 0.55),
        important_message_limit=_positive_int(compaction.get("important_message_limit"), 6),
        important_token_ratio=_ratio_value(compaction.get("important_token_ratio"), 0.25),
        summary_token_ratio=_ratio_value(compaction.get("summary_token_ratio"), 0.35),
        per_message_token_limit=_positive_int(compaction.get("per_message_token_limit"), 240),
        artifact_token_ratio=_ratio_value(compaction.get("artifact_token_ratio"), 0.20),
        artifact_max_tokens=_positive_int(compaction.get("artifact_max_tokens"), 4000),
        paper_evidence_limit=_positive_int(compaction.get("paper_evidence_limit"), 3),
    )


def _memory_config_from_raw(raw_memory: dict[str, Any]) -> MemoryConfig:
    return MemoryConfig(
        retrieval_limit=_positive_int(raw_memory.get("retrieval_limit"), 8),
        vector_dimensions=_positive_int(raw_memory.get("vector_dimensions"), 96),
        paper_evidence_ttl_days=_positive_int(raw_memory.get("paper_evidence_ttl_days"), 30),
        stale_recheck_enabled=bool(raw_memory.get("stale_recheck_enabled", True)),
        conflict_detection_enabled=bool(raw_memory.get("conflict_detection_enabled", True)),
    )


def _search_source_list(value: Any, fallback: list[SearchSource]) -> list[SearchSource]:
    if not isinstance(value, list):
        return fallback
    sources = [item for item in value if item in DEFAULT_SEARCH_API_KEY_ENVS]
    return sources or fallback


def _optional_str(value: Any, fallback: str | None) -> str | None:
    return value if isinstance(value, str) and value.strip() else fallback


def _positive_optional_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _positive_int(value: Any, fallback: int) -> int:
    parsed = _positive_optional_int(value)
    return parsed if parsed is not None else fallback


def _float_value(value: Any, fallback: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _ratio_value(value: Any, fallback: float) -> float:
    parsed = _float_value(value, fallback)
    return min(0.95, max(0.05, parsed))


def _deep_merge(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    merged = {**left}
    for key, value in right.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _apply_env_overrides(
    profiles: dict[ProviderProfileName, ProviderProfileConfig],
    env: dict[str, str],
) -> None:
    provider = env.get("ACADEMIC_AGENT_PROVIDER")
    model = env.get("ACADEMIC_AGENT_MODEL")
    base_url = env.get("ACADEMIC_AGENT_BASE_URL")
    api_key_env = env.get("ACADEMIC_AGENT_API_KEY_ENV")
    reasoning_effort = env.get("ACADEMIC_AGENT_REASONING_EFFORT")
    reasoning_summary = env.get("ACADEMIC_AGENT_REASONING_SUMMARY")
    if not provider and not model and not base_url and not api_key_env and not reasoning_effort and not reasoning_summary:
        return

    if "planner" in profiles:
        planner = profiles["planner"].model_dump(mode="json")
    elif provider:
        planner = _profile_from_payload("planner", {"provider": provider}).model_dump(
            mode="json"
        )
    else:
        return
    if provider:
        planner["provider"] = provider
        if provider in DEFAULT_MODELS:
            provider_name = provider
            planner["model"] = model or DEFAULT_MODELS[provider_name]
            planner["api_key_env"] = api_key_env or DEFAULT_API_KEY_ENVS[provider_name]
            planner["base_url"] = base_url or DEFAULT_BASE_URLS[provider_name]
    if model:
        planner["model"] = model
    if base_url:
        planner["base_url"] = base_url
    if api_key_env:
        planner["api_key_env"] = api_key_env
    if reasoning_effort:
        planner["reasoning_effort"] = reasoning_effort
    if reasoning_summary:
        planner["reasoning_summary"] = reasoning_summary
    profiles["planner"] = ProviderProfileConfig.model_validate(planner)
