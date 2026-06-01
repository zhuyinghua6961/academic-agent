from __future__ import annotations

import json
import os
import re
from copy import deepcopy
from json import JSONDecodeError
from typing import Any, Protocol

import httpx

from .config import live_providers_enabled
from .harness import stable_json_hash
from .schemas import (
    Diagnosis,
    ProviderProfileConfig,
    ProviderRequest,
    ProviderResponse,
    ThreadMessage,
    new_id,
    utc_now,
)


PROMPT_VERSION = "idea-plan-diagnosis-v0.3"
APP_USER_AGENT = "academic-agent/0.1.0"


class ProviderError(RuntimeError):
    pass


class IdeaDiagnosisProvider(Protocol):
    config: ProviderProfileConfig

    def build_request(
        self, idea: str, context_id: str, history: list[ThreadMessage] | None = None
    ) -> ProviderRequest:
        ...

    def generate_idea_diagnosis(self, request: ProviderRequest, idea: str) -> ProviderResponse:
        ...

    def generate_thread_title(self, idea: str, diagnosis: Diagnosis) -> str:
        ...

    def build_agent_request(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> ProviderRequest:
        ...

    def generate_agent_response(
        self,
        request: ProviderRequest,
        tools: list[dict[str, Any]] | None = None,
    ) -> ProviderResponse:
        ...


class BaseIdeaDiagnosisProvider:
    def __init__(self, config: ProviderProfileConfig, env: dict[str, str] | None = None) -> None:
        self.config = config
        self.env = dict(env if env is not None else os.environ)

    def build_request(
        self, idea: str, context_id: str, history: list[ThreadMessage] | None = None
    ) -> ProviderRequest:
        messages: list[dict[str, Any]] = [
            {
                "role": "system",
                "content": _system_prompt(),
            },
            {
                "role": "user",
                "content": _user_prompt(idea, history or []),
                "context_id": context_id,
                "history": [message.model_dump(mode="json") for message in (history or [])],
            },
        ]
        return ProviderRequest(
            request_id=new_id("provider_req"),
            provider=self.config.provider,
            model=self.config.model,
            profile=self.config.profile,
            messages=messages,
            prompt_version=PROMPT_VERSION,
            input_hash=stable_json_hash(
                {
                    "idea": idea,
                    "provider": self.config.provider,
                    "model": self.config.model,
                    "prompt_version": PROMPT_VERSION,
                    "reasoning_effort": self.config.reasoning_effort,
                    "reasoning_summary": self.config.reasoning_summary,
                    "system_prompt": _system_prompt(),
                    "history": _history_signature(history or []),
                }
            ),
            created_at=utc_now(),
        )

    def _api_key(self) -> str:
        if self.config.provider == "mock":
            return ""
        if not live_providers_enabled(self.env):
            raise ProviderError(
                "Live providers are disabled. Set ACADEMIC_AGENT_ENABLE_LIVE_PROVIDERS=1 "
                "to call a non-mock provider."
            )
        if not self.config.api_key_env:
            raise ProviderError(f"Provider {self.config.provider} requires api_key_env.")
        api_key = self.env.get(self.config.api_key_env)
        if not api_key:
            raise ProviderError(f"Missing API key env var: {self.config.api_key_env}")
        return api_key

    def _fallback_thread_title(self, idea: str) -> str:
        cleaned = " ".join(idea.strip().split())
        if not cleaned:
            return "Untitled Research Idea"
        words = cleaned.split()
        title = " ".join(words[:8])
        if len(title) > 60:
            title = ""
            for word in words:
                candidate = word if not title else f"{title} {word}"
                if len(candidate) > 60:
                    break
                title = candidate
            if not title:
                title = cleaned[:60]
        return _sanitize_thread_title(title)

    def build_agent_request(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> ProviderRequest:
        return ProviderRequest(
            request_id=new_id("provider_req"),
            provider=self.config.provider,
            model=self.config.model,
            profile=self.config.profile,
            messages=messages,
            prompt_version=PROMPT_VERSION,
            input_hash=stable_json_hash(
                {
                    "provider": self.config.provider,
                    "model": self.config.model,
                    "prompt_version": PROMPT_VERSION,
                    "reasoning_effort": self.config.reasoning_effort,
                    "reasoning_summary": self.config.reasoning_summary,
                    "system_prompt": _agent_system_prompt(),
                    "messages": _agent_messages_signature(messages),
                    "tools": tools or [],
                }
            ),
            created_at=utc_now(),
        )

    def generate_agent_response(
        self,
        request: ProviderRequest,
        tools: list[dict[str, Any]] | None = None,
    ) -> ProviderResponse:
        raise NotImplementedError


class DeterministicMockProvider(BaseIdeaDiagnosisProvider):
    def generate_idea_diagnosis(self, request: ProviderRequest, idea: str) -> ProviderResponse:
        diagnosis = self._mock_diagnosis(idea)
        output = {"diagnosis": diagnosis.model_dump(mode="json")}
        return ProviderResponse(
            response_id=new_id("provider_resp"),
            request_id=request.request_id,
            provider=self.config.provider,
            model=self.config.model,
            output=output,
            usage={
                "input_tokens": 0,
                "output_tokens": 0,
                "cache_read_tokens": 0,
                "note": "deterministic mock provider",
            },
            cached=False,
            created_at=utc_now(),
        )

    def generate_thread_title(self, idea: str, diagnosis: Diagnosis) -> str:
        return self._fallback_thread_title(idea)

    def generate_agent_response(
        self,
        request: ProviderRequest,
        tools: list[dict[str, Any]] | None = None,
    ) -> ProviderResponse:
        # Extract idea from the last user message
        idea = ""
        for msg in reversed(request.messages):
            if msg.get("role") == "user" and isinstance(msg.get("content"), str):
                idea = _latest_user_input_from_agent_content(msg["content"])
                break
        diagnosis_json = json.dumps(self._mock_diagnosis(idea).model_dump(mode="json"), ensure_ascii=False)
        return ProviderResponse(
            response_id=new_id("provider_resp"),
            request_id=request.request_id,
            provider=self.config.provider,
            model=self.config.model,
            output={
                "content": diagnosis_json,
                "tool_calls": [],
                "finish_reason": "stop",
            },
            usage={
                "input_tokens": 0,
                "output_tokens": 0,
                "note": "deterministic mock agent provider",
            },
            cached=False,
            created_at=utc_now(),
        )

    def _mock_diagnosis(self, idea: str) -> Diagnosis:
        cleaned = " ".join(idea.strip().split())
        return Diagnosis(
            problem=f"用户提出的研究方向是：{cleaned}",
            gap=(
                "v0 尚未检索近邻论文，因此只能把 gap 标记为待证伪假设；"
                "后续必须通过 Idea Plan Mode 的文献检索确认 novelty。"
            ),
            candidate_mechanism=(
                "候选机制应被重构为一个可被实验验证的核心算法或交互机制，"
                "而不是简单的 LLM/RAG/workflow 拼装。"
            ),
            evidence_needed=[
                "检索 5-8 篇最接近的顶会论文并产出 mini-review。",
                "定义主 claim、失败标准和可区分近邻工作的机制假设。",
                "设计能支持、削弱或推翻主 claim 的实验蓝图。",
            ],
            main_uncertainty=(
                "当前最大不确定性是：该 idea 是否存在真实机制创新，"
                "以及能否通过强 baseline 与 ablation 排除工程拼装解释。"
            ),
            clarifying_questions=[
                "目标任务的输入是什么：参考图、楼层/列号、坐标、自然语言描述，还是人工点击？",
                "你希望核心创新落在算法机制、数据/benchmark、理论分析，还是人机协作流程？",
                "可用数据和实验资源是什么：无人机视频、位姿/SLAM、建筑图纸、标注预算分别有多少？",
            ],
        )


class OpenAIResponsesProvider(BaseIdeaDiagnosisProvider):
    def generate_idea_diagnosis(self, request: ProviderRequest, idea: str) -> ProviderResponse:
        api_key = self._api_key()
        base_url = (self.config.base_url or "https://api.openai.com/v1").rstrip("/")
        body = openai_responses_body(
            self.config,
            idea,
            _history_from_request(request),
            prompt_cache_key=_openai_prompt_cache_key(self.config),
        )

        with httpx.Client(timeout=60.0, trust_env=False) as client:
            response = _post_with_unsupported_parameter_retries(
                client=client,
                url=f"{base_url}/responses",
                headers=_openai_headers(api_key),
                body=body,
            )
        if response.status_code >= 400:
            raise ProviderError(f"OpenAI provider error {response.status_code}: {response.text}")

        payload = _openai_payload_from_response(response)
        diagnosis = _diagnosis_from_text(_openai_output_text(payload))
        return ProviderResponse(
            response_id=new_id("provider_resp"),
            request_id=request.request_id,
            provider=self.config.provider,
            model=self.config.model,
            output={"diagnosis": diagnosis.model_dump(mode="json")},
            usage=_normalize_openai_usage(payload.get("usage", {})),
            cached=_openai_cached(payload.get("usage", {})),
            provider_request_id=response.headers.get("x-request-id") or payload.get("id"),
            created_at=utc_now(),
        )

    def generate_thread_title(self, idea: str, diagnosis: Diagnosis) -> str:
        api_key = self._api_key()
        base_url = (self.config.base_url or "https://api.openai.com/v1").rstrip("/")
        body = {
            "model": self.config.model,
            "instructions": _title_system_prompt(),
            "input": [{"role": "user", "content": _title_user_prompt(idea, diagnosis)}],
            "max_output_tokens": 40,
        }
        with httpx.Client(timeout=30.0, trust_env=False) as client:
            response = _post_with_unsupported_parameter_retries(
                client=client,
                url=f"{base_url}/responses",
                headers=_openai_headers(api_key),
                body=body,
            )
        if response.status_code >= 400:
            raise ProviderError(f"OpenAI title provider error {response.status_code}: {response.text}")
        payload = _openai_payload_from_response(response)
        return _sanitize_thread_title(_openai_output_text(payload))

    def generate_agent_response(
        self,
        request: ProviderRequest,
        tools: list[dict[str, Any]] | None = None,
    ) -> ProviderResponse:
        api_key = self._api_key()
        base_url = (self.config.base_url or "https://api.openai.com/v1").rstrip("/")
        body = openai_responses_agent_body(
            self.config,
            request.messages,
            tools or [],
            prompt_cache_key=_openai_agent_prompt_cache_key(self.config, tools or []),
        )

        with httpx.Client(timeout=60.0, trust_env=False) as client:
            response = _post_with_unsupported_parameter_retries(
                client=client,
                url=f"{base_url}/responses",
                headers=_openai_headers(api_key),
                body=body,
            )
        if response.status_code >= 400:
            raise ProviderError(f"OpenAI agent error {response.status_code}: {response.text}")

        payload = _openai_payload_from_response(response)
        tool_calls = _openai_response_tool_calls(payload)
        content = _openai_output_text_or_none(payload)
        return ProviderResponse(
            response_id=new_id("provider_resp"),
            request_id=request.request_id,
            provider=self.config.provider,
            model=self.config.model,
            output={
                "content": content,
                "tool_calls": tool_calls,
                "finish_reason": "tool_calls" if tool_calls else "stop",
            },
            usage=_normalize_openai_usage(payload.get("usage", {})),
            cached=_openai_cached(payload.get("usage", {})),
            provider_request_id=response.headers.get("x-request-id") or payload.get("id"),
            created_at=utc_now(),
        )


class AnthropicMessagesProvider(BaseIdeaDiagnosisProvider):
    def generate_idea_diagnosis(self, request: ProviderRequest, idea: str) -> ProviderResponse:
        api_key = self._api_key()
        base_url = (self.config.base_url or "https://api.anthropic.com").rstrip("/")
        body: dict[str, Any] = {
            "model": self.config.model,
            "max_tokens": self.config.max_output_tokens,
            "system": _system_prompt(),
            "messages": [{"role": "user", "content": _user_prompt(idea, _history_from_request(request))}],
        }
        if self.config.temperature is not None:
            body["temperature"] = self.config.temperature

        with httpx.Client(timeout=60.0, trust_env=False) as client:
            response = client.post(
                f"{base_url}/v1/messages",
                headers=_anthropic_headers(api_key),
                json=body,
            )
        if response.status_code >= 400:
            raise ProviderError(f"Anthropic provider error {response.status_code}: {response.text}")

        try:
            payload = response.json()
        except JSONDecodeError as exc:
            raise ProviderError(
                f"Anthropic provider returned non-JSON response: {response.text[:500]}"
            ) from exc
        diagnosis = _diagnosis_from_text(_anthropic_output_text(payload))
        return ProviderResponse(
            response_id=new_id("provider_resp"),
            request_id=request.request_id,
            provider=self.config.provider,
            model=self.config.model,
            output={"diagnosis": diagnosis.model_dump(mode="json")},
            usage=_normalize_anthropic_usage(payload.get("usage", {})),
            cached=False,
            provider_request_id=response.headers.get("request-id") or payload.get("id"),
            created_at=utc_now(),
        )

    def generate_thread_title(self, idea: str, diagnosis: Diagnosis) -> str:
        api_key = self._api_key()
        base_url = (self.config.base_url or "https://api.anthropic.com").rstrip("/")
        body: dict[str, Any] = {
            "model": self.config.model,
            "max_tokens": 40,
            "system": _title_system_prompt(),
            "messages": [{"role": "user", "content": _title_user_prompt(idea, diagnosis)}],
        }
        with httpx.Client(timeout=30.0, trust_env=False) as client:
            response = client.post(
                f"{base_url}/v1/messages",
                headers=_anthropic_headers(api_key),
                json=body,
            )
        if response.status_code >= 400:
            raise ProviderError(f"Anthropic title provider error {response.status_code}: {response.text}")
        try:
            payload = response.json()
        except JSONDecodeError as exc:
            raise ProviderError(
                f"Anthropic title provider returned non-JSON response: {response.text[:500]}"
            ) from exc
        return _sanitize_thread_title(_anthropic_output_text(payload))

    def generate_agent_response(
        self,
        request: ProviderRequest,
        tools: list[dict[str, Any]] | None = None,
    ) -> ProviderResponse:
        api_key = self._api_key()
        base_url = (self.config.base_url or "https://api.anthropic.com").rstrip("/")
        body = anthropic_agent_body(self.config, request.messages, tools or [])

        with httpx.Client(timeout=60.0, trust_env=False) as client:
            response = client.post(
                f"{base_url}/v1/messages",
                headers=_anthropic_headers(api_key),
                json=body,
            )
        if response.status_code >= 400:
            raise ProviderError(f"Anthropic agent error {response.status_code}: {response.text}")

        try:
            payload = response.json()
        except JSONDecodeError as exc:
            raise ProviderError(
                f"Anthropic agent returned non-JSON response: {response.text[:500]}"
            ) from exc
        text = _anthropic_output_text_or_none(payload)
        tool_calls = _anthropic_tool_calls(payload)
        return ProviderResponse(
            response_id=new_id("provider_resp"),
            request_id=request.request_id,
            provider=self.config.provider,
            model=self.config.model,
            output={
                "content": text,
                "tool_calls": tool_calls,
                "finish_reason": "tool_calls" if tool_calls else payload.get("stop_reason", "stop"),
            },
            usage=_normalize_anthropic_usage(payload.get("usage", {})),
            cached=bool(payload.get("usage", {}).get("cache_read_input_tokens", 0)),
            provider_request_id=response.headers.get("request-id") or payload.get("id"),
            created_at=utc_now(),
        )


class OpenAICompatibleChatProvider(BaseIdeaDiagnosisProvider):
    def generate_idea_diagnosis(self, request: ProviderRequest, idea: str) -> ProviderResponse:
        api_key = self._api_key()
        base_url = (self.config.base_url or "http://127.0.0.1:8000/v1").rstrip("/")
        body: dict[str, Any] = {
            "model": self.config.model,
            "messages": [
                {"role": "system", "content": _system_prompt()},
                {"role": "user", "content": _user_prompt(idea, _history_from_request(request))},
            ],
            "max_tokens": self.config.max_output_tokens,
        }
        if self.config.temperature is not None:
            body["temperature"] = self.config.temperature

        with httpx.Client(timeout=60.0, trust_env=False) as client:
            response = client.post(
                f"{base_url}/chat/completions",
                headers=_openai_headers(api_key),
                json=body,
            )
        if response.status_code >= 400:
            raise ProviderError(
                f"OpenAI-compatible provider error {response.status_code}: {response.text}"
            )

        try:
            payload = response.json()
        except JSONDecodeError as exc:
            raise ProviderError(
                f"OpenAI-compatible provider returned non-JSON response: {response.text[:500]}"
            ) from exc
        content = payload["choices"][0]["message"]["content"]
        diagnosis = _diagnosis_from_text(content)
        return ProviderResponse(
            response_id=new_id("provider_resp"),
            request_id=request.request_id,
            provider=self.config.provider,
            model=self.config.model,
            output={"diagnosis": diagnosis.model_dump(mode="json")},
            usage=payload.get("usage", {}),
            cached=False,
            provider_request_id=response.headers.get("x-request-id") or payload.get("id"),
            created_at=utc_now(),
        )

    def generate_thread_title(self, idea: str, diagnosis: Diagnosis) -> str:
        api_key = self._api_key()
        base_url = (self.config.base_url or "http://127.0.0.1:8000/v1").rstrip("/")
        body: dict[str, Any] = {
            "model": self.config.model,
            "messages": [
                {"role": "system", "content": _title_system_prompt()},
                {"role": "user", "content": _title_user_prompt(idea, diagnosis)},
            ],
            "max_tokens": 40,
        }
        with httpx.Client(timeout=30.0, trust_env=False) as client:
            response = client.post(
                f"{base_url}/chat/completions",
                headers=_openai_headers(api_key),
                json=body,
            )
        if response.status_code >= 400:
            raise ProviderError(
                f"OpenAI-compatible title provider error {response.status_code}: {response.text}"
            )
        try:
            payload = response.json()
        except JSONDecodeError as exc:
            raise ProviderError(
                f"OpenAI-compatible title provider returned non-JSON response: {response.text[:500]}"
            ) from exc
        return _sanitize_thread_title(payload["choices"][0]["message"]["content"])

    def generate_agent_response(
        self,
        request: ProviderRequest,
        tools: list[dict[str, Any]] | None = None,
    ) -> ProviderResponse:
        api_key = self._api_key()
        base_url = (self.config.base_url or "http://127.0.0.1:8000/v1").rstrip("/")
        body: dict[str, Any] = {
            "model": self.config.model,
            "messages": request.messages,
            "max_tokens": self.config.max_output_tokens,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        if self.config.temperature is not None:
            body["temperature"] = self.config.temperature

        with httpx.Client(timeout=60.0, trust_env=False) as client:
            response = client.post(
                f"{base_url}/chat/completions",
                headers=_openai_headers(api_key),
                json=body,
            )
        if response.status_code >= 400:
            raise ProviderError(
                f"OpenAI-compatible agent error {response.status_code}: {response.text}"
            )

        try:
            payload = response.json()
        except JSONDecodeError as exc:
            raise ProviderError(
                f"OpenAI-compatible agent returned non-JSON response: {response.text[:500]}"
            ) from exc

        choice = payload["choices"][0]
        message = choice.get("message", {})
        tool_calls = _chat_tool_calls(message)
        usage = _normalize_openai_usage(payload.get("usage", {}))
        return ProviderResponse(
            response_id=new_id("provider_resp"),
            request_id=request.request_id,
            provider=self.config.provider,
            model=self.config.model,
            output={
                "content": message.get("content"),
                "tool_calls": tool_calls,
                "finish_reason": "tool_calls" if tool_calls else choice.get("finish_reason", "stop"),
            },
            usage=usage,
            cached=_openai_cached(payload.get("usage", {})),
            provider_request_id=response.headers.get("x-request-id") or payload.get("id"),
            created_at=utc_now(),
        )


class DeepSeekChatProvider(BaseIdeaDiagnosisProvider):
    """DeepSeek provider using the OpenAI-compatible /chat/completions API.

    Uses function calling (OpenAI-format tools) for web search and other
    capabilities.  The model is trained on this format and handles tool
    calling correctly.  Context caching works automatically for repeated
    system-prompt prefixes.
    """

    def _chat_post(self, body: dict[str, Any], timeout: float = 60.0) -> httpx.Response:
        api_key = self._api_key()
        base_url = (self.config.base_url or "https://api.deepseek.com").rstrip("/")
        with httpx.Client(timeout=timeout, trust_env=False) as client:
            return client.post(
                f"{base_url}/chat/completions",
                headers=_openai_headers(api_key),
                json=body,
            )

    # --- Public API ---------------------------------------------------------------

    def generate_idea_diagnosis(self, request: ProviderRequest, idea: str) -> ProviderResponse:
        body: dict[str, Any] = {
            "model": self.config.model,
            "messages": [
                {"role": "system", "content": _system_prompt()},
                {"role": "user", "content": _user_prompt(idea, _history_from_request(request))},
            ],
            "max_tokens": self.config.max_output_tokens,
        }
        if self.config.temperature is not None:
            body["temperature"] = self.config.temperature
        _apply_deepseek_reasoning(body, self.config)

        response = self._chat_post(body)
        if response.status_code >= 400:
            raise ProviderError(f"DeepSeek provider error {response.status_code}: {response.text}")
        try:
            payload = response.json()
        except JSONDecodeError as exc:
            raise ProviderError(f"DeepSeek provider returned non-JSON response: {response.text[:500]}") from exc

        content = payload["choices"][0]["message"]["content"]
        diagnosis = _diagnosis_from_text(content)
        usage = _normalize_deepseek_usage(payload.get("usage", {}))
        return ProviderResponse(
            response_id=new_id("provider_resp"),
            request_id=request.request_id,
            provider=self.config.provider,
            model=self.config.model,
            output={"diagnosis": diagnosis.model_dump(mode="json")},
            usage=usage,
            cached=_deepseek_context_cache_hit(payload.get("usage", {})),
            provider_request_id=response.headers.get("x-request-id") or payload.get("id"),
            created_at=utc_now(),
        )

    def generate_agent_response(
        self,
        request: ProviderRequest,
        tools: list[dict[str, Any]] | None = None,
    ) -> ProviderResponse:
        body: dict[str, Any] = {
            "model": self.config.model,
            "messages": request.messages,
            "max_tokens": self.config.max_output_tokens,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        if self.config.temperature is not None:
            body["temperature"] = self.config.temperature
        _apply_deepseek_reasoning(body, self.config)

        response = self._chat_post(body)
        if response.status_code >= 400:
            raise ProviderError(f"DeepSeek agent error {response.status_code}: {response.text}")

        try:
            payload = response.json()
        except JSONDecodeError as exc:
            raise ProviderError(f"DeepSeek agent returned non-JSON response: {response.text[:500]}") from exc

        choice = payload["choices"][0]
        finish_reason = choice.get("finish_reason", "stop")
        message = choice.get("message", {})
        content = message.get("content")
        reasoning_content = message.get("reasoning_content")
        tool_calls = _chat_tool_calls(message)
        usage = _normalize_deepseek_usage(payload.get("usage", {}))

        return ProviderResponse(
            response_id=new_id("provider_resp"),
            request_id=request.request_id,
            provider=self.config.provider,
            model=self.config.model,
            output={
                "content": content,
                "reasoning_content": reasoning_content,
                "tool_calls": tool_calls,
                "finish_reason": "tool_calls" if tool_calls else finish_reason,
            },
            usage=usage,
            cached=_deepseek_context_cache_hit(payload.get("usage", {})),
            provider_request_id=response.headers.get("x-request-id") or payload.get("id"),
            created_at=utc_now(),
        )

    def generate_thread_title(self, idea: str, diagnosis: Diagnosis) -> str:
        body: dict[str, Any] = {
            "model": self.config.model,
            "messages": [
                {"role": "system", "content": _title_system_prompt()},
                {"role": "user", "content": _title_user_prompt(idea, diagnosis)},
            ],
            "max_tokens": 40,
        }
        response = self._chat_post(body, timeout=30.0)
        if response.status_code >= 400:
            raise ProviderError(f"DeepSeek title provider error {response.status_code}: {response.text}")
        try:
            payload = response.json()
        except JSONDecodeError as exc:
            raise ProviderError(f"DeepSeek title provider returned non-JSON response: {response.text[:500]}") from exc
        return _sanitize_thread_title(payload["choices"][0]["message"]["content"])


def create_idea_diagnosis_provider(
    config: ProviderProfileConfig,
    env: dict[str, str] | None = None,
) -> IdeaDiagnosisProvider:
    if config.provider == "mock":
        return DeterministicMockProvider(config, env)
    if config.provider == "openai":
        return OpenAIResponsesProvider(config, env)
    if config.provider == "anthropic":
        return AnthropicMessagesProvider(config, env)
    if config.provider == "openai_compatible":
        return OpenAICompatibleChatProvider(config, env)
    if config.provider == "deepseek":
        return DeepSeekChatProvider(config, env)
    raise ProviderError(f"Unsupported provider: {config.provider}")


def _openai_headers(api_key: str) -> dict[str, str]:
    return {
        "authorization": f"Bearer {api_key}",
        "content-type": "application/json",
        "user-agent": APP_USER_AGENT,
    }


def _anthropic_headers(api_key: str) -> dict[str, str]:
    return {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "user-agent": APP_USER_AGENT,
    }


def _chat_tool_calls(message: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract tool calls from an OpenAI-format chat response message."""
    tool_calls: list[dict[str, Any]] = []
    for tc in message.get("tool_calls") or []:
        func = tc.get("function", {})
        try:
            args = json.loads(func.get("arguments", "{}"))
        except (json.JSONDecodeError, TypeError):
            args = {}
        tool_calls.append(
            {
                "call_id": tc.get("id", ""),
                "name": func.get("name", ""),
                "arguments": args,
            }
        )
    return tool_calls


def openai_responses_agent_body(
    config: ProviderProfileConfig,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    prompt_cache_key: str | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": config.model,
        "instructions": _system_instructions_from_messages(messages, _agent_system_prompt()),
        "input": _openai_responses_input_from_messages(messages),
        "max_output_tokens": config.max_output_tokens,
    }
    if tools:
        body["tools"] = [_openai_response_tool_definition(tool) for tool in tools]
        body["tool_choice"] = "auto"
    if prompt_cache_key:
        body["prompt_cache_key"] = prompt_cache_key
        body["prompt_cache_retention"] = "24h"
    if config.temperature is not None:
        body["temperature"] = config.temperature

    reasoning: dict[str, str] = {}
    if config.reasoning_effort:
        reasoning["effort"] = config.reasoning_effort
    if config.reasoning_summary:
        reasoning["summary"] = config.reasoning_summary
    if reasoning:
        body["reasoning"] = reasoning

    return body


def anthropic_agent_body(
    config: ProviderProfileConfig,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": config.model,
        "max_tokens": config.max_output_tokens,
        "system": _system_instructions_from_messages(messages, _agent_system_prompt()),
        "messages": _anthropic_messages_from_chat(messages),
    }
    if tools:
        body["tools"] = [_anthropic_tool_definition(tool) for tool in tools]
    if config.temperature is not None:
        body["temperature"] = config.temperature
    return body


def _system_instructions_from_messages(messages: list[dict[str, Any]], fallback: str) -> str:
    chunks = [
        str(message.get("content", ""))
        for message in messages
        if message.get("role") == "system" and message.get("content")
    ]
    return "\n\n".join(chunks) if chunks else fallback


def _openai_responses_input_from_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        if role == "system":
            continue
        if role == "tool":
            call_id = str(message.get("tool_call_id") or "")
            if call_id:
                items.append(
                    {
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": str(message.get("content") or ""),
                    }
                )
            continue
        if role == "assistant":
            content = message.get("content")
            if content:
                items.append({"role": "assistant", "content": str(content)})
            for tool_call in message.get("tool_calls") or []:
                function = tool_call.get("function", {})
                arguments = function.get("arguments", "{}")
                if not isinstance(arguments, str):
                    arguments = json.dumps(arguments, ensure_ascii=False)
                items.append(
                    {
                        "type": "function_call",
                        "call_id": tool_call.get("id", ""),
                        "name": function.get("name", ""),
                        "arguments": arguments,
                    }
                )
            continue
        if role == "user":
            items.append({"role": "user", "content": str(message.get("content") or "")})
    return items


def _openai_response_tool_definition(tool: dict[str, Any]) -> dict[str, Any]:
    function = tool.get("function", {})
    if tool.get("type") == "function" and function:
        return {
            "type": "function",
            "name": function.get("name", ""),
            "description": function.get("description", ""),
            "parameters": function.get("parameters", {"type": "object", "properties": {}}),
        }
    return tool


def _openai_response_tool_calls(payload: dict[str, Any]) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    for item in payload.get("output", []):
        if item.get("type") != "function_call":
            continue
        try:
            args = json.loads(item.get("arguments") or "{}")
        except (json.JSONDecodeError, TypeError):
            args = {}
        calls.append(
            {
                "call_id": item.get("call_id") or item.get("id", ""),
                "name": item.get("name", ""),
                "arguments": args,
            }
        )
    return calls


def _anthropic_tool_definition(tool: dict[str, Any]) -> dict[str, Any]:
    function = tool.get("function", {})
    if tool.get("type") == "function" and function:
        return {
            "name": function.get("name", ""),
            "description": function.get("description", ""),
            "input_schema": function.get("parameters", {"type": "object", "properties": {}}),
        }
    return tool


def _anthropic_messages_from_chat(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    converted: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        if role == "system":
            continue
        if role == "tool":
            call_id = str(message.get("tool_call_id") or "")
            if call_id:
                converted.append(
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": call_id,
                                "content": str(message.get("content") or ""),
                            }
                        ],
                    }
                )
            continue
        if role == "assistant":
            content_blocks: list[dict[str, Any]] = []
            content = message.get("content")
            if content:
                content_blocks.append({"type": "text", "text": str(content)})
            for tool_call in message.get("tool_calls") or []:
                function = tool_call.get("function", {})
                try:
                    args = json.loads(function.get("arguments") or "{}")
                except (json.JSONDecodeError, TypeError):
                    args = {}
                content_blocks.append(
                    {
                        "type": "tool_use",
                        "id": tool_call.get("id", ""),
                        "name": function.get("name", ""),
                        "input": args,
                    }
                )
            if content_blocks:
                converted.append({"role": "assistant", "content": content_blocks})
            continue
        if role == "user":
            converted.append({"role": "user", "content": str(message.get("content") or "")})
    return converted


def _anthropic_tool_calls(payload: dict[str, Any]) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    for item in payload.get("content", []):
        if item.get("type") == "tool_use":
            args = item.get("input")
            calls.append(
                {
                    "call_id": item.get("id", ""),
                    "name": item.get("name", ""),
                    "arguments": args if isinstance(args, dict) else {},
                }
            )
    return calls


def openai_responses_body(
    config: ProviderProfileConfig,
    idea: str,
    history: list[ThreadMessage] | None = None,
    prompt_cache_key: str | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": config.model,
        "instructions": _system_prompt(),
        "input": [{"role": "user", "content": _user_prompt(idea, history or [])}],
        "max_output_tokens": config.max_output_tokens,
    }
    if prompt_cache_key:
        body["prompt_cache_key"] = prompt_cache_key
        body["prompt_cache_retention"] = "24h"
    if config.temperature is not None:
        body["temperature"] = config.temperature

    reasoning: dict[str, str] = {}
    if config.reasoning_effort:
        reasoning["effort"] = config.reasoning_effort
    if config.reasoning_summary:
        reasoning["summary"] = config.reasoning_summary
    if reasoning:
        body["reasoning"] = reasoning

    return body


def _post_with_unsupported_parameter_retries(
    client: httpx.Client,
    url: str,
    headers: dict[str, str],
    body: dict[str, Any],
) -> httpx.Response:
    current = deepcopy(body)
    removed: set[str] = set()
    for _ in range(4):
        response = client.post(url, headers=headers, json=current)
        if response.status_code != 400:
            return response

        parameter = _unsupported_parameter(response.text)
        if parameter is None or parameter in removed:
            return response
        if not _remove_parameter(current, parameter):
            return response
        removed.add(parameter)
    return response


def _openai_payload_from_response(response: httpx.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except JSONDecodeError:
        payload = _payload_from_sse(response.text)
        if payload is not None:
            return payload
        raise ProviderError(f"OpenAI provider returned non-JSON response: {response.text[:500]}")
    if not isinstance(payload, dict):
        raise ProviderError(f"OpenAI provider returned non-object JSON: {response.text[:500]}")
    return payload


def _payload_from_sse(text: str) -> dict[str, Any] | None:
    completed: dict[str, Any] | None = None
    last_payload: dict[str, Any] | None = None
    output_text_chunks: list[str] = []
    for block in text.split("\n\n"):
        data_lines = [
            line.removeprefix("data:").strip()
            for line in block.splitlines()
            if line.startswith("data:")
        ]
        if not data_lines:
            continue
        data = "\n".join(data_lines)
        if data == "[DONE]":
            continue
        try:
            payload = json.loads(data)
        except JSONDecodeError:
            continue
        last_payload = payload
        if payload.get("type") == "response.output_text.delta" and isinstance(
            payload.get("delta"), str
        ):
            output_text_chunks.append(payload["delta"])
        if payload.get("type") == "response.output_text.done" and isinstance(
            payload.get("text"), str
        ):
            output_text_chunks = [payload["text"]]
        if payload.get("type") == "response.completed" and isinstance(payload.get("response"), dict):
            completed = payload["response"]
    if completed is not None and output_text_chunks and "output_text" not in completed:
        completed["output_text"] = "".join(output_text_chunks)
    if completed is None and output_text_chunks:
        return {"output_text": "".join(output_text_chunks)}
    return completed or last_payload


def _unsupported_parameter(text: str) -> str | None:
    match = re.search(r"Unsupported parameter: ([A-Za-z0-9_.-]+)", text)
    if match:
        return match.group(1)
    return None


def _remove_parameter(body: dict[str, Any], parameter: str) -> bool:
    parts = parameter.split(".")
    target: Any = body
    for part in parts[:-1]:
        if not isinstance(target, dict) or part not in target:
            return False
        target = target[part]
    if isinstance(target, dict) and parts[-1] in target:
        del target[parts[-1]]
        return True
    return False


def _system_prompt() -> str:
    return (
        "You are an academic research mentor and top-conference reviewer. "
        "Diagnose the user's raw research idea. Return only valid JSON with this shape: "
        '{"problem": string, "gap": string, "candidate_mechanism": string, '
        '"evidence_needed": string[], "main_uncertainty": string, '
        '"clarifying_questions": string[]}. '
        "Language contract: write every JSON string value in the same natural language "
        "as the latest user input. If the latest user input is Chinese, all diagnosis "
        "values and questions must be Chinese. Keep JSON keys in English. "
        "Do not claim novelty without evidence. Be direct about uncertainty."
    )


def _agent_system_prompt() -> str:
    return (
        "You are an academic research mentor. Use paper_search for nearby papers and "
        "academic related work; use web_search only as a fallback for non-paper information. "
        "For novelty checks, call paper_search with sort_by='hybrid' so arXiv returns both "
        "relevant papers and newly submitted preprints. When the user asks for latest, "
        "new, recent, current, or today's papers/preprints, call paper_search with "
        "sort_by='submitted_date'. "
        "Language contract: write every JSON string value in the same natural language "
        "as Latest user input. If Latest user input is Chinese, all diagnosis values, "
        "evidence items, and questions must be Chinese. Keep JSON keys in English. "
        "After search results appear, output ONLY a raw JSON object — no markdown, "
        "no code fences, no XML tags, no tool_call syntax. The exact format:\n"
        '{"problem":"...","gap":"...","candidate_mechanism":"...",'
        '"evidence_needed":["..."],"main_uncertainty":"...",'
        '"clarifying_questions":["..."]}\n'
        "IMPORTANT: Never output <｜tool_calls｜> or <｜invoke or any XML. "
        "Just the JSON."
    )


def _title_system_prompt() -> str:
    return (
        "You name academic research planning conversations. "
        "Return only one concise title, no quotes, no markdown, no punctuation at the end."
    )


def _title_user_prompt(idea: str, diagnosis: Diagnosis) -> str:
    return (
        f"Raw idea:\n{idea}\n\n"
        f"Problem diagnosis:\n{diagnosis.problem}\n\n"
        "Write a 4-10 word title in the same language as the raw idea when possible."
    )


def _user_prompt(idea: str, history: list[ThreadMessage]) -> str:
    history_text = "\n".join(
        f"{message.role.upper()}: {message.content}" for message in history[-12:]
    )
    if not history_text:
        history_text = "No previous discussion in this thread."
    return (
        f"Thread history:\n{history_text}\n\n"
        f"Latest user input:\n{idea}\n\n"
        "Response language: use the same natural language as Latest user input for "
        "all JSON string values. Keep JSON keys in English.\n"
        "Return an updated diagnosis JSON now. "
        "Ask 2-4 clarifying_questions that would most improve top-conference-level idea planning."
    )


def _history_from_request(request: ProviderRequest) -> list[ThreadMessage]:
    for message in request.messages:
        history = message.get("history")
        if isinstance(history, list):
            return [ThreadMessage.model_validate(item) for item in history]
    return []


def _history_signature(history: list[ThreadMessage]) -> list[dict[str, str]]:
    return [{"role": message.role, "content": message.content} for message in history]


def _agent_messages_signature(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    signature: list[dict[str, Any]] = []
    for message in messages:
        item: dict[str, Any] = {
            "role": message.get("role"),
            "content": message.get("content"),
        }
        if message.get("tool_call_id"):
            item["tool_call_id"] = message.get("tool_call_id")
        if message.get("name"):
            item["name"] = message.get("name")
        if message.get("tool_calls"):
            item["tool_calls"] = message.get("tool_calls")
        signature.append(item)
    return signature


def _latest_user_input_from_agent_content(content: str) -> str:
    marker = "Latest user input:\n"
    if marker not in content:
        return content
    after_marker = content.split(marker, 1)[1]
    for delimiter in (
        "\n\nResponse language",
        "\n\nResearch this idea",
        "\n\nReturn an updated diagnosis",
        "\n\nTool observations",
    ):
        if delimiter in after_marker:
            return after_marker.split(delimiter, 1)[0].strip()
    return after_marker.strip()


def _diagnosis_from_text(text: str) -> Diagnosis:
    cleaned = _strip_xml_tool_calls(text)
    cleaned = cleaned.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.startswith("json"):
            cleaned = cleaned[4:].strip()
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ProviderError(f"Provider did not return valid diagnosis JSON: {text[:500]}") from exc
    return Diagnosis.model_validate(payload)


def _strip_xml_tool_calls(text: str) -> str:
    """Remove OpenAI-format XML tool_call artifacts from model text output.

    Some DeepSeek models, when called through the Anthropic endpoint, confuse
    the OpenAI ``<｜tool_calls｜>`` XML syntax with proper Anthropic content
    blocks.  This function strips those artifacts so the remaining JSON (if
    any) can be parsed.
    """
    import re as _re

    result = text
    # Nested XML tags with Unicode full-width vertical bars (U+FF5C)
    result = _re.sub(
        r"<\s*[｜\|]?\s*tool[_\s]*calls?\s*[｜\|]?\s*>.*?</\s*[｜\|]?\s*tool[_\s]*calls?\s*[｜\|]?\s*>",
        "", result, flags=_re.DOTALL | _re.IGNORECASE,
    )
    # Self-closing or individual invoke/parameter tags
    result = _re.sub(
        r"<\s*[｜\|]?\s*(?:invoke|parameter)\s+[^>]*/\s*>",
        "", result, flags=_re.IGNORECASE,
    )
    result = _re.sub(
        r"<\s*[｜\|]?\s*(?:invoke|parameter)\s+[^>]*>.*?</\s*[｜\|]?\s*(?:invoke|parameter)\s*>",
        "", result, flags=_re.DOTALL | _re.IGNORECASE,
    )
    return result


def _sanitize_thread_title(text: str) -> str:
    title = " ".join(text.strip().strip("`\"'“”‘’").split())
    title = re.sub(r"^[#*\-\d.\s]+", "", title).strip()
    if not title:
        return "Untitled Research Idea"
    if len(title) > 60:
        title = title[:57].rstrip() + "..."
    return title


def _openai_output_text(payload: dict[str, Any]) -> str:
    if isinstance(payload.get("output_text"), str):
        return str(payload["output_text"])
    chunks: list[str] = []
    for item in payload.get("output", []):
        for content in item.get("content", []):
            if content.get("type") in {"output_text", "text"} and isinstance(content.get("text"), str):
                chunks.append(str(content["text"]))
    if not chunks:
        raise ProviderError("OpenAI response did not contain output text.")
    return "\n".join(chunks)


def _openai_output_text_or_none(payload: dict[str, Any]) -> str | None:
    try:
        return _openai_output_text(payload)
    except ProviderError:
        return None


def _anthropic_output_text(payload: dict[str, Any]) -> str:
    chunks = [
        item["text"]
        for item in payload.get("content", [])
        if item.get("type") == "text" and isinstance(item.get("text"), str)
    ]
    if not chunks:
        raise ProviderError("Anthropic response did not contain text content.")
    return "\n".join(chunks)


def _anthropic_output_text_or_none(payload: dict[str, Any]) -> str | None:
    chunks = [
        item["text"]
        for item in payload.get("content", [])
        if item.get("type") == "text" and isinstance(item.get("text"), str)
    ]
    return "\n".join(chunks) if chunks else None


def _normalize_openai_usage(usage: dict[str, Any]) -> dict[str, Any]:
    input_tokens = usage.get("input_tokens", usage.get("prompt_tokens", 0))
    output_tokens = usage.get("output_tokens", usage.get("completion_tokens", 0))
    details = (
        usage.get("input_tokens_details")
        or usage.get("prompt_tokens_details")
        or usage.get("input_tokens_detail")
        or {}
    )
    cached_tokens = (
        details.get("cached_tokens", 0)
        or usage.get("input_cached_tokens", 0)
        or usage.get("prompt_cached_tokens", 0)
        or usage.get("cached_tokens", 0)
    )
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": usage.get("total_tokens", input_tokens + output_tokens),
        "cache_read_tokens": cached_tokens,
        "input_tokens_details": details,
    }


def _openai_cached(usage: dict[str, Any]) -> bool:
    details = (
        usage.get("input_tokens_details")
        or usage.get("prompt_tokens_details")
        or usage.get("input_tokens_detail")
        or {}
    )
    cached_tokens = (
        details.get("cached_tokens", 0)
        or usage.get("input_cached_tokens", 0)
        or usage.get("prompt_cached_tokens", 0)
        or usage.get("cached_tokens", 0)
    )
    return bool(cached_tokens)


def _openai_prompt_cache_key(config: ProviderProfileConfig) -> str:
    return stable_json_hash(
        {
            "provider": config.provider,
            "profile": config.profile,
            "model": config.model,
            "prompt_version": PROMPT_VERSION,
            "system_prompt": _system_prompt(),
            "reasoning_effort": config.reasoning_effort,
            "reasoning_summary": config.reasoning_summary,
        }
    )


def _openai_agent_prompt_cache_key(config: ProviderProfileConfig, tools: list[dict[str, Any]]) -> str:
    return stable_json_hash(
        {
            "provider": config.provider,
            "profile": config.profile,
            "model": config.model,
            "prompt_version": PROMPT_VERSION,
            "system_prompt": _agent_system_prompt(),
            "tools": tools,
            "reasoning_effort": config.reasoning_effort,
            "reasoning_summary": config.reasoning_summary,
        }
    )


def _normalize_anthropic_usage(usage: dict[str, Any]) -> dict[str, Any]:
    cache_creation = usage.get("cache_creation_input_tokens", 0)
    cache_read = usage.get("cache_read_input_tokens", 0)
    return {
        "input_tokens": usage.get("input_tokens", 0),
        "output_tokens": usage.get("output_tokens", 0),
        "cache_creation_input_tokens": cache_creation,
        "cache_read_tokens": cache_read,
    }


def _apply_deepseek_reasoning(body: dict[str, Any], config: ProviderProfileConfig) -> None:
    """Inject reasoning parameters for the /chat/completions endpoint."""
    if not config.reasoning_effort:
        return
    reasoning: dict[str, str] = {"effort": config.reasoning_effort}
    if config.reasoning_summary:
        reasoning["summary"] = config.reasoning_summary
    body["reasoning"] = reasoning


def _normalize_deepseek_usage(usage: dict[str, Any]) -> dict[str, Any]:
    """Normalize DeepSeek usage, surfacing context-cache hit/miss tokens.

    DeepSeek returns ``prompt_cache_hit_tokens`` and ``prompt_cache_miss_tokens``
    at the top level of the usage object (not nested inside a details sub-object).
    We rename ``prompt_cache_hit_tokens`` to ``cache_read_tokens`` for
    consistency with the rest of the system's usage normalisation.
    """
    hit = usage.get("prompt_cache_hit_tokens", 0)
    miss = usage.get("prompt_cache_miss_tokens", 0)
    return {
        "input_tokens": usage.get("prompt_tokens", usage.get("input_tokens", 0)),
        "output_tokens": usage.get("completion_tokens", usage.get("output_tokens", 0)),
        "total_tokens": usage.get("total_tokens", 0),
        "cache_read_tokens": hit,
        "prompt_cache_hit_tokens": hit,
        "prompt_cache_miss_tokens": miss,
    }


def _deepseek_context_cache_hit(usage: dict[str, Any]) -> bool:
    """Return True when DeepSeek's server-side context cache was engaged."""
    return bool(usage.get("prompt_cache_hit_tokens", 0))
