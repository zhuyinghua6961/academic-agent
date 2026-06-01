from __future__ import annotations

import re
import time
import xml.etree.ElementTree as ET
from typing import Protocol

import httpx
from duckduckgo_search import DDGS

from .config import SearchConfig
from .schemas import PaperSearchSort, SearchResponse, SearchResult, SearchSource, utc_now


SEARCH_USER_AGENT = "academic-agent/0.1.0"
ARXIV_API_URL = "https://export.arxiv.org/api/query"
OPENALEX_API_URL = "https://api.openalex.org/works"
ATOM_NS = {"atom": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}
SOURCE_RATE_LIMIT_COOLDOWN_SECONDS = 120.0


class SearchProvider(Protocol):
    source: SearchSource

    def search(self, query: str, max_results: int = 8) -> list[SearchResult]:
        ...


class DuckDuckGoSearchProvider:
    source: SearchSource = "duckduckgo"

    def search(self, query: str, max_results: int = 8) -> list[SearchResult]:
        if not query.strip():
            return []
        retrieved_at = utc_now()
        with DDGS() as ddgs:
            raw_results = list(ddgs.text(query, max_results=max_results))
        return [
            SearchResult(
                source=self.source,
                title=str(result.get("title", "")),
                snippet=str(result.get("body", "")),
                url=str(result.get("href", "")),
                retrieved_at=retrieved_at,
                metadata={"backend": "duckduckgo"},
            )
            for result in raw_results
            if result.get("href")
        ]


class BraveSearchProvider:
    source: SearchSource = "brave"

    def __init__(
        self,
        api_key: str,
        api_url: str,
        timeout: float = 30.0,
        trust_env: bool = True,
    ) -> None:
        self.api_key = api_key
        self.api_url = api_url
        self.timeout = timeout
        self.trust_env = trust_env

    def search(self, query: str, max_results: int = 8) -> list[SearchResult]:
        if not query.strip():
            return []
        params: dict[str, str | int] = {"q": query, "count": max_results}
        with httpx.Client(timeout=self.timeout, trust_env=self.trust_env) as client:
            response = client.get(
                self.api_url,
                params=params,
                headers={
                    "accept": "application/json",
                    "x-subscription-token": self.api_key,
                    "user-agent": SEARCH_USER_AGENT,
                },
            )
        response.raise_for_status()
        return parse_brave_web_results(response.json(), retrieved_at=utc_now())


class TavilySearchProvider:
    source: SearchSource = "tavily"

    def __init__(
        self,
        api_key: str,
        api_url: str,
        timeout: float = 30.0,
        trust_env: bool = True,
    ) -> None:
        self.api_key = api_key
        self.api_url = api_url
        self.timeout = timeout
        self.trust_env = trust_env

    def search(self, query: str, max_results: int = 8) -> list[SearchResult]:
        if not query.strip():
            return []
        with httpx.Client(timeout=self.timeout, trust_env=self.trust_env) as client:
            response = client.post(
                self.api_url,
                json={
                    "query": query,
                    "max_results": max_results,
                    "search_depth": "basic",
                    "include_answer": False,
                    "include_raw_content": False,
                },
                headers={
                    "authorization": f"Bearer {self.api_key}",
                    "content-type": "application/json",
                    "user-agent": SEARCH_USER_AGENT,
                },
            )
        response.raise_for_status()
        return parse_tavily_results(response.json(), retrieved_at=utc_now())


class SerperSearchProvider:
    source: SearchSource = "serper"

    def __init__(
        self,
        api_key: str,
        api_url: str,
        timeout: float = 30.0,
        trust_env: bool = True,
    ) -> None:
        self.api_key = api_key
        self.api_url = api_url
        self.timeout = timeout
        self.trust_env = trust_env

    def search(self, query: str, max_results: int = 8) -> list[SearchResult]:
        if not query.strip():
            return []
        with httpx.Client(timeout=self.timeout, trust_env=self.trust_env) as client:
            response = client.post(
                self.api_url,
                json={"q": query, "num": max_results},
                headers={
                    "x-api-key": self.api_key,
                    "content-type": "application/json",
                    "user-agent": SEARCH_USER_AGENT,
                },
            )
        response.raise_for_status()
        return parse_serper_results(response.json(), retrieved_at=utc_now())


class SerpApiSearchProvider:
    source: SearchSource = "serpapi"

    def __init__(
        self,
        api_key: str,
        api_url: str,
        timeout: float = 30.0,
        trust_env: bool = True,
    ) -> None:
        self.api_key = api_key
        self.api_url = api_url
        self.timeout = timeout
        self.trust_env = trust_env

    def search(self, query: str, max_results: int = 8) -> list[SearchResult]:
        if not query.strip():
            return []
        params: dict[str, str | int] = {
            "engine": "google",
            "q": query,
            "api_key": self.api_key,
            "num": max_results,
        }
        with httpx.Client(timeout=self.timeout, trust_env=self.trust_env) as client:
            response = client.get(
                self.api_url,
                params=params,
                headers={"user-agent": SEARCH_USER_AGENT},
            )
        response.raise_for_status()
        return parse_serpapi_results(response.json(), retrieved_at=utc_now())


class ArxivSearchProvider:
    source: SearchSource = "arxiv"

    def __init__(
        self,
        api_url: str = ARXIV_API_URL,
        timeout: float = 30.0,
        trust_env: bool = True,
    ) -> None:
        self.api_url = api_url
        self.timeout = timeout
        self.trust_env = trust_env

    def search(
        self,
        query: str,
        max_results: int = 8,
        sort_by: PaperSearchSort = "hybrid",
    ) -> list[SearchResult]:
        if not query.strip():
            return []
        if sort_by == "hybrid":
            return self._hybrid_search(query, max_results)
        api_sort_by = _arxiv_api_sort_by(sort_by)
        return self._search_variants(
            query=query,
            max_results=max_results,
            api_sort_by=api_sort_by,
            requested_sort=sort_by,
        )

    def _fetch(self, search_query: str, max_results: int, sort_by: str) -> httpx.Response:
        params: dict[str, str | int] = {
            "search_query": search_query,
            "start": 0,
            "max_results": max_results,
            "sortBy": sort_by,
            "sortOrder": "descending",
        }
        with httpx.Client(timeout=self.timeout, trust_env=self.trust_env) as client:
            return client.get(
                self.api_url,
                params=params,
                headers={"user-agent": SEARCH_USER_AGENT},
            )

    def _search_variants(
        self,
        query: str,
        max_results: int,
        api_sort_by: str,
        requested_sort: PaperSearchSort,
    ) -> list[SearchResult]:
        last_results: list[SearchResult] = []
        for search_query in arxiv_search_queries(query):
            response = self._fetch(search_query, max_results, api_sort_by)
            response.raise_for_status()
            parsed = parse_arxiv_feed(response.text, retrieved_at=utc_now())
            annotated = _annotate_arxiv_sort(
                parsed,
                requested_sort=requested_sort,
                api_sort=api_sort_by,
                arxiv_query=search_query,
            )
            if annotated:
                return annotated
            last_results = annotated
        return last_results

    def _hybrid_search(self, query: str, max_results: int) -> list[SearchResult]:
        relevance_count = max(1, max_results // 2)
        latest_count = max_results
        relevance_results = self._search_variants(
            query=query,
            max_results=relevance_count,
            api_sort_by="relevance",
            requested_sort="hybrid",
        )
        latest_results = self._search_variants(
            query=query,
            max_results=latest_count,
            api_sort_by="submittedDate",
            requested_sort="hybrid",
        )
        return _merge_search_results([*relevance_results, *latest_results], max_results)


class OpenAlexSearchProvider:
    source: SearchSource = "openalex"

    def __init__(
        self,
        api_url: str = OPENALEX_API_URL,
        timeout: float = 30.0,
        trust_env: bool = True,
    ) -> None:
        self.api_url = api_url
        self.timeout = timeout
        self.trust_env = trust_env

    def search(self, query: str, max_results: int = 8) -> list[SearchResult]:
        if not query.strip():
            return []
        response = self._fetch(query, max_results)
        response.raise_for_status()
        return parse_openalex_works(response.json(), query=query, retrieved_at=utc_now())

    def _fetch(self, query: str, max_results: int) -> httpx.Response:
        params: dict[str, str | int] = {
            "search": query,
            "per-page": max_results,
        }
        with httpx.Client(timeout=self.timeout, trust_env=self.trust_env) as client:
            return client.get(
                self.api_url,
                params=params,
                headers={"user-agent": SEARCH_USER_AGENT},
            )


class SearchEngine:
    def __init__(
        self,
        providers: list[SearchProvider] | None = None,
        paper_sources: list[SearchSource] | None = None,
        web_sources: list[SearchSource] | None = None,
    ) -> None:
        self.providers: dict[SearchSource, SearchProvider] = {
            provider.source: provider for provider in providers or []
        }
        self.paper_sources = paper_sources or ["arxiv", "openalex"]
        self.web_sources = web_sources or ["brave", "tavily", "serper", "serpapi", "duckduckgo"]
        self._source_cooldown_until: dict[SearchSource, float] = {}

    def web_search(self, query: str, max_results: int = 8) -> SearchResponse:
        return self._search_with_sources(
            query,
            max_results,
            self.web_sources,
            response_source="web_search",
        )

    def paper_search(
        self,
        query: str,
        max_results: int = 8,
        sources: list[SearchSource] | None = None,
        sort_by: PaperSearchSort = "hybrid",
    ) -> SearchResponse:
        selected_sources = sources or self.paper_sources
        return self._search_with_sources(
            query,
            max_results,
            selected_sources,
            response_source="paper_search",
            sort_by=sort_by,
        )

    def _search_with_sources(
        self,
        query: str,
        max_results: int,
        sources: list[SearchSource],
        response_source: str,
        sort_by: PaperSearchSort = "relevance",
    ) -> SearchResponse:
        normalized_limit = max(1, min(max_results, 25))
        if not query.strip():
            return SearchResponse(
                query=query,
                source=response_source,
                results=[],
                retrieved_at=utc_now(),
                error="Empty query",
            )

        results: list[SearchResult] = []
        errors: list[str] = []
        seen: set[str] = set()
        for source in sources:
            cooldown_remaining = self._cooldown_remaining(source)
            if cooldown_remaining > 0:
                errors.append(f"{source}: skipped after recent rate limit ({cooldown_remaining:.0f}s cooldown)")
                continue
            provider = self.providers.get(source)
            if provider is None:
                errors.append(f"Search source is not configured: {source}")
                continue
            remaining = normalized_limit - len(results)
            if remaining <= 0:
                break
            try:
                if source == "arxiv" and isinstance(provider, ArxivSearchProvider):
                    provider_results = provider.search(
                        query,
                        max_results=remaining,
                        sort_by=sort_by,
                    )
                else:
                    provider_results = provider.search(query, max_results=remaining)
            except Exception as exc:
                errors.append(f"{source}: {exc}")
                if _is_rate_limit_error(exc):
                    self._source_cooldown_until[source] = (
                        time.monotonic() + SOURCE_RATE_LIMIT_COOLDOWN_SECONDS
                    )
                continue
            for result in provider_results:
                key = _dedupe_key(result)
                if key in seen:
                    continue
                seen.add(key)
                results.append(result)
                if len(results) >= normalized_limit:
                    break

        return SearchResponse(
            query=query,
            source=response_source,
            results=results,
            retrieved_at=utc_now(),
            error=" | ".join(errors) if errors else None,
        )

    def _cooldown_remaining(self, source: SearchSource) -> float:
        until = self._source_cooldown_until.get(source, 0.0)
        return max(0.0, until - time.monotonic())


def create_default_search_engine(
    search_config: SearchConfig | None = None,
    env: dict[str, str] | None = None,
) -> SearchEngine:
    if search_config is None:
        return SearchEngine(
            [ArxivSearchProvider(), OpenAlexSearchProvider(), DuckDuckGoSearchProvider()]
        )
    providers: list[SearchProvider] = []
    for source, provider_config in search_config.providers.items():
        if not provider_config.enabled:
            continue
        if source == "arxiv" and provider_config.base_url:
            providers.append(
                ArxivSearchProvider(
                    api_url=provider_config.base_url,
                    timeout=search_config.timeout_seconds,
                    trust_env=search_config.trust_env,
                )
            )
        elif source == "openalex" and provider_config.base_url:
            providers.append(
                OpenAlexSearchProvider(
                    api_url=provider_config.base_url,
                    timeout=search_config.timeout_seconds,
                    trust_env=search_config.trust_env,
                )
            )
        elif source == "duckduckgo":
            providers.append(DuckDuckGoSearchProvider())
        elif source == "brave" and provider_config.base_url:
            api_key = _search_api_key(provider_config.api_key_env, env)
            if api_key:
                providers.append(
                    BraveSearchProvider(
                        api_key=api_key,
                        api_url=provider_config.base_url,
                        timeout=search_config.timeout_seconds,
                        trust_env=search_config.trust_env,
                    )
                )
        elif source == "tavily" and provider_config.base_url:
            api_key = _search_api_key(provider_config.api_key_env, env)
            if api_key:
                providers.append(
                    TavilySearchProvider(
                        api_key=api_key,
                        api_url=provider_config.base_url,
                        timeout=search_config.timeout_seconds,
                        trust_env=search_config.trust_env,
                    )
                )
        elif source == "serper" and provider_config.base_url:
            api_key = _search_api_key(provider_config.api_key_env, env)
            if api_key:
                providers.append(
                    SerperSearchProvider(
                        api_key=api_key,
                        api_url=provider_config.base_url,
                        timeout=search_config.timeout_seconds,
                        trust_env=search_config.trust_env,
                    )
                )
        elif source == "serpapi" and provider_config.base_url:
            api_key = _search_api_key(provider_config.api_key_env, env)
            if api_key:
                providers.append(
                    SerpApiSearchProvider(
                        api_key=api_key,
                        api_url=provider_config.base_url,
                        timeout=search_config.timeout_seconds,
                        trust_env=search_config.trust_env,
                    )
                )
    configured_sources = {provider.source for provider in providers}
    return SearchEngine(
        providers,
        paper_sources=[
            source for source in search_config.paper_sources if source in configured_sources
        ],
        web_sources=[
            source for source in search_config.web_sources if source in configured_sources
        ],
    )


def arxiv_search_query(query: str) -> str:
    queries = arxiv_search_queries(query)
    return queries[0] if queries else ""


def arxiv_search_queries(query: str) -> list[str]:
    normalized = " ".join(query.strip().split())
    if not normalized:
        return []
    if _looks_like_arxiv_advanced_query(normalized):
        return [normalized]
    terms = [
        re.sub(r"[^A-Za-z0-9_.-]", "", term)
        for term in normalized.split()
        if re.sub(r"[^A-Za-z0-9_.-]", "", term)
    ]
    if not terms:
        return [f'all:"{normalized}"']
    variants = [
        " AND ".join(f"all:{term}" for term in terms[:8]),
    ]
    if len(terms) > 4:
        variants.append(" AND ".join(f"all:{term}" for term in terms[:4]))
    if len(terms) > 3:
        variants.append(" AND ".join(f"all:{term}" for term in terms[:3]))
    if len(terms) > 2:
        variants.append(" AND ".join(f"all:{term}" for term in terms[-3:]))
    deduped: list[str] = []
    for variant in variants:
        if variant and variant not in deduped:
            deduped.append(variant)
    return deduped


def _arxiv_api_sort_by(sort_by: PaperSearchSort) -> str:
    if sort_by == "submitted_date":
        return "submittedDate"
    return "relevance"


def _annotate_arxiv_sort(
    results: list[SearchResult],
    requested_sort: PaperSearchSort,
    api_sort: str,
    arxiv_query: str | None = None,
) -> list[SearchResult]:
    return [
        result.model_copy(
            update={
                "metadata": {
                    **result.metadata,
                    "requested_sort": requested_sort,
                    "api_sort": api_sort,
                    "arxiv_query": arxiv_query,
                }
            }
        )
        for result in results
    ]


def _merge_search_results(results: list[SearchResult], max_results: int) -> list[SearchResult]:
    merged: list[SearchResult] = []
    seen: set[str] = set()
    for result in results:
        key = _dedupe_key(result)
        if key in seen:
            continue
        seen.add(key)
        merged.append(result)
        if len(merged) >= max_results:
            break
    return merged


def parse_arxiv_feed(feed_text: str, retrieved_at: str | None = None) -> list[SearchResult]:
    root = ET.fromstring(feed_text)
    timestamp = retrieved_at or utc_now()
    results: list[SearchResult] = []
    for entry in root.findall("atom:entry", ATOM_NS):
        title = _text(entry, "atom:title")
        summary = _text(entry, "atom:summary")
        url = _text(entry, "atom:id")
        links = entry.findall("atom:link", ATOM_NS)
        pdf_url = _arxiv_pdf_url(links)
        authors = [
            _normalize_ws(name.text or "")
            for name in entry.findall("atom:author/atom:name", ATOM_NS)
            if name.text
        ]
        external_id = url.rstrip("/").rsplit("/", 1)[-1] if url else None
        categories = [
            category.attrib.get("term", "")
            for category in entry.findall("atom:category", ATOM_NS)
            if category.attrib.get("term")
        ]
        primary_category = entry.find("arxiv:primary_category", ATOM_NS)
        doi = _text(entry, "arxiv:doi")
        journal_ref = _text(entry, "arxiv:journal_ref")
        comment = _text(entry, "arxiv:comment")
        if title and url:
            results.append(
                SearchResult(
                    source="arxiv",
                    title=title,
                    snippet=summary,
                    url=url,
                    retrieved_at=timestamp,
                    external_id=external_id,
                    authors=authors,
                    published_at=_text(entry, "atom:published") or None,
                    updated_at=_text(entry, "atom:updated") or None,
                    pdf_url=pdf_url,
                    metadata={
                        "backend": "arxiv",
                        "primary_category": (
                            primary_category.attrib.get("term") if primary_category is not None else None
                        ),
                        "categories": categories,
                        "doi": doi or None,
                        "journal_ref": journal_ref or None,
                        "comment": comment or None,
                    },
                )
            )
    return results


def parse_openalex_works(
    payload: dict[str, object],
    query: str,
    retrieved_at: str | None = None,
) -> list[SearchResult]:
    timestamp = retrieved_at or utc_now()
    raw_results = payload.get("results", [])
    if not isinstance(raw_results, list):
        return []
    results: list[SearchResult] = []
    for raw_item in raw_results:
        if not isinstance(raw_item, dict):
            continue
        title = str(raw_item.get("title") or raw_item.get("display_name") or "").strip()
        url = _openalex_landing_url(raw_item)
        if not title or not url:
            continue
        openalex_id = str(raw_item.get("id") or "")
        doi = raw_item.get("doi")
        authors = _openalex_authors(raw_item)
        abstract = _abstract_from_openalex(raw_item.get("abstract_inverted_index"))
        pdf_url = _openalex_pdf_url(raw_item)
        results.append(
            SearchResult(
                source="openalex",
                title=title,
                snippet=abstract,
                url=url,
                retrieved_at=timestamp,
                external_id=openalex_id.rsplit("/", 1)[-1] if openalex_id else None,
                authors=authors,
                published_at=str(raw_item.get("publication_date") or "") or None,
                updated_at=str(raw_item.get("updated_date") or "") or None,
                pdf_url=pdf_url,
                metadata={
                    "backend": "openalex",
                    "query": query,
                    "doi": doi if isinstance(doi, str) else None,
                    "cited_by_count": raw_item.get("cited_by_count"),
                    "publication_year": raw_item.get("publication_year"),
                    "openalex_id": openalex_id or None,
                },
            )
        )
    return results


def parse_brave_web_results(payload: dict[str, object], retrieved_at: str | None = None) -> list[SearchResult]:
    timestamp = retrieved_at or utc_now()
    web = payload.get("web")
    raw_results = web.get("results", []) if isinstance(web, dict) else []
    if not isinstance(raw_results, list):
        return []
    results: list[SearchResult] = []
    for raw_item in raw_results:
        if not isinstance(raw_item, dict):
            continue
        title = str(raw_item.get("title") or "").strip()
        url = str(raw_item.get("url") or "").strip()
        if not title or not url:
            continue
        results.append(
            SearchResult(
                source="brave",
                title=title,
                snippet=str(raw_item.get("description") or ""),
                url=url,
                retrieved_at=timestamp,
                metadata={"backend": "brave", "age": raw_item.get("age")},
            )
        )
    return results


def parse_tavily_results(payload: dict[str, object], retrieved_at: str | None = None) -> list[SearchResult]:
    timestamp = retrieved_at or utc_now()
    raw_results = payload.get("results", [])
    if not isinstance(raw_results, list):
        return []
    results: list[SearchResult] = []
    for raw_item in raw_results:
        if not isinstance(raw_item, dict):
            continue
        title = str(raw_item.get("title") or "").strip()
        url = str(raw_item.get("url") or "").strip()
        if not title or not url:
            continue
        results.append(
            SearchResult(
                source="tavily",
                title=title,
                snippet=str(raw_item.get("content") or ""),
                url=url,
                retrieved_at=timestamp,
                metadata={"backend": "tavily", "score": raw_item.get("score")},
            )
        )
    return results


def parse_serper_results(payload: dict[str, object], retrieved_at: str | None = None) -> list[SearchResult]:
    timestamp = retrieved_at or utc_now()
    raw_results = payload.get("organic", [])
    if not isinstance(raw_results, list):
        return []
    results: list[SearchResult] = []
    for raw_item in raw_results:
        if not isinstance(raw_item, dict):
            continue
        title = str(raw_item.get("title") or "").strip()
        url = str(raw_item.get("link") or "").strip()
        if not title or not url:
            continue
        results.append(
            SearchResult(
                source="serper",
                title=title,
                snippet=str(raw_item.get("snippet") or ""),
                url=url,
                retrieved_at=timestamp,
                metadata={
                    "backend": "serper",
                    "position": raw_item.get("position"),
                    "date": raw_item.get("date"),
                },
            )
        )
    return results


def parse_serpapi_results(payload: dict[str, object], retrieved_at: str | None = None) -> list[SearchResult]:
    timestamp = retrieved_at or utc_now()
    raw_results = payload.get("organic_results", [])
    if not isinstance(raw_results, list):
        return []
    results: list[SearchResult] = []
    for raw_item in raw_results:
        if not isinstance(raw_item, dict):
            continue
        title = str(raw_item.get("title") or "").strip()
        url = str(raw_item.get("link") or "").strip()
        if not title or not url:
            continue
        results.append(
            SearchResult(
                source="serpapi",
                title=title,
                snippet=str(raw_item.get("snippet") or ""),
                url=url,
                retrieved_at=timestamp,
                metadata={
                    "backend": "serpapi",
                    "position": raw_item.get("position"),
                    "displayed_link": raw_item.get("displayed_link"),
                },
            )
        )
    return results


def _looks_like_arxiv_advanced_query(query: str) -> bool:
    return bool(re.search(r"\b(?:ti|au|abs|co|jr|cat|rn|id|all):", query))


def _normalize_ws(text: str) -> str:
    return " ".join(text.strip().split())


def _text(entry: ET.Element, path: str) -> str:
    found = entry.find(path, ATOM_NS)
    return _normalize_ws(found.text or "") if found is not None and found.text else ""


def _arxiv_pdf_url(links: list[ET.Element]) -> str | None:
    for link in links:
        if link.attrib.get("title") == "pdf" and link.attrib.get("href"):
            return link.attrib["href"]
    return None


def _dedupe_key(result: SearchResult) -> str:
    if result.external_id:
        return result.external_id
    return result.url or f"{result.source}:{result.title}"


def _is_rate_limit_error(exc: Exception) -> bool:
    if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 429:
        return True
    return "429" in str(exc)


def _search_api_key(api_key_env: str | None, env: dict[str, str] | None) -> str | None:
    if not api_key_env or env is None:
        return None
    value = env.get(api_key_env)
    return value if value else None


def _openalex_landing_url(item: dict[str, object]) -> str:
    primary_location = item.get("primary_location")
    if isinstance(primary_location, dict):
        landing_page_url = primary_location.get("landing_page_url")
        if isinstance(landing_page_url, str) and landing_page_url:
            return landing_page_url
    doi = item.get("doi")
    if isinstance(doi, str) and doi:
        return doi
    openalex_id = item.get("id")
    return str(openalex_id or "")


def _openalex_pdf_url(item: dict[str, object]) -> str | None:
    primary_location = item.get("primary_location")
    if isinstance(primary_location, dict):
        pdf_url = primary_location.get("pdf_url")
        if isinstance(pdf_url, str) and pdf_url:
            return pdf_url
    return None


def _openalex_authors(item: dict[str, object]) -> list[str]:
    authorships = item.get("authorships")
    if not isinstance(authorships, list):
        return []
    authors: list[str] = []
    for authorship in authorships:
        if not isinstance(authorship, dict):
            continue
        author = authorship.get("author")
        if isinstance(author, dict):
            name = author.get("display_name")
            if isinstance(name, str) and name:
                authors.append(name)
    return authors


def _abstract_from_openalex(value: object) -> str:
    if not isinstance(value, dict):
        return ""
    positions: dict[int, str] = {}
    for word, raw_indexes in value.items():
        if not isinstance(word, str) or not isinstance(raw_indexes, list):
            continue
        for raw_index in raw_indexes:
            if isinstance(raw_index, int):
                positions[raw_index] = word
    return " ".join(positions[index] for index in sorted(positions))
