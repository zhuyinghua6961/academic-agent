"""Academic Agent search-ingest service (Phase 2).

MVP continues to use TypeScript search tools in agent-core.
This service provides HTTP endpoints for future Agent tool migration.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx
import structlog
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ],
)
log = structlog.get_logger(service="search-ingest")

app = FastAPI(title="Academic Agent Search Ingest", version="0.1.0")


class PaperSearchRequest(BaseModel):
    query: str = Field(min_length=1)
    sources: list[str] = Field(default_factory=lambda: ["arxiv", "openalex"])
    limit: int = Field(default=10, ge=1, le=50)


class PaperSearchHit(BaseModel):
    source: str
    title: str
    url: str | None = None
    year: int | None = None
    authors: list[str] = Field(default_factory=list)


class PaperSearchResponse(BaseModel):
    query: str
    hits: list[PaperSearchHit]


async def search_arxiv(client: httpx.AsyncClient, query: str, limit: int) -> list[PaperSearchHit]:
    response = await client.get(
        "https://export.arxiv.org/api/query",
        params={"search_query": f"all:{query}", "start": 0, "max_results": limit},
        timeout=30.0,
    )
    response.raise_for_status()
    # Minimal Atom parse: extract entry titles via simple tags (real impl would use feedparser)
    text = response.text
    hits: list[PaperSearchHit] = []
    for chunk in text.split("<entry>")[1:]:
        title = _xml_tag(chunk, "title")
        if not title:
            continue
        link = _xml_tag(chunk, "id")
        hits.append(PaperSearchHit(source="arxiv", title=title.strip(), url=link))
    return hits


async def search_openalex(client: httpx.AsyncClient, query: str, limit: int) -> list[PaperSearchHit]:
    response = await client.get(
        "https://api.openalex.org/works",
        params={"search": query, "per_page": limit},
        timeout=30.0,
    )
    response.raise_for_status()
    payload = response.json()
    hits: list[PaperSearchHit] = []
    for item in payload.get("results", []):
        hits.append(
            PaperSearchHit(
                source="openalex",
                title=str(item.get("title") or "Untitled"),
                url=item.get("id"),
                year=(item.get("publication_year") if isinstance(item.get("publication_year"), int) else None),
                authors=[
                    str(a.get("author", {}).get("display_name", ""))
                    for a in item.get("authorships", [])
                    if a.get("author")
                ],
            )
        )
    return hits


def _xml_tag(chunk: str, tag: str) -> str | None:
    open_tag = f"<{tag}>"
    close_tag = f"</{tag}>"
    if open_tag not in chunk or close_tag not in chunk:
        return None
    return chunk.split(open_tag, 1)[1].split(close_tag, 1)[0]


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "search-ingest-python"}


@app.post("/v1/papers/search", response_model=PaperSearchResponse)
async def paper_search(request: PaperSearchRequest) -> PaperSearchResponse:
    log.info("paper_search", query=request.query, sources=request.sources, span="search")
    hits: list[PaperSearchHit] = []
    async with httpx.AsyncClient() as client:
        if "arxiv" in request.sources:
            try:
                hits.extend(await search_arxiv(client, request.query, request.limit))
            except httpx.HTTPError as exc:
                log.error("arxiv_search_failed", error=str(exc))
                raise HTTPException(status_code=502, detail="arxiv search failed") from exc
        if "openalex" in request.sources:
            try:
                hits.extend(await search_openalex(client, request.query, request.limit))
            except httpx.HTTPError as exc:
                log.error("openalex_search_failed", error=str(exc))
                raise HTTPException(status_code=502, detail="openalex search failed") from exc
    return PaperSearchResponse(query=request.query, hits=hits[: request.limit])


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8090"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")
