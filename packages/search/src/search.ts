import type {SearchConfig} from "@academic-agent/config";
import type {PaperSearchSort, SearchResponse, SearchResult, SearchSource} from "@academic-agent/schemas";
import {utcNow} from "@academic-agent/schemas";

export const SEARCH_USER_AGENT = "academic-agent/0.1.0";
export const ARXIV_API_URL = "https://export.arxiv.org/api/query";
export const OPENALEX_API_URL = "https://api.openalex.org/works";
const SOURCE_RATE_LIMIT_COOLDOWN_SECONDS = 120.0;

export interface SearchProvider {
  readonly source: SearchSource;
  search(query: string, maxResults?: number, sortBy?: PaperSearchSort): Promise<SearchResult[]>;
}

type JsonObject = Record<string, unknown>;

interface FetchOptions {
  timeoutSeconds: number;
  headers?: Record<string, string>;
  params?: Record<string, string | number>;
  method?: "GET" | "POST";
  body?: unknown;
}

async function httpRequest(url: string, options: FetchOptions): Promise<Response> {
  const urlObj = new URL(url);
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      urlObj.searchParams.set(key, String(value));
    }
  }
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: options.headers,
    signal: AbortSignal.timeout(options.timeoutSeconds * 1000),
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(urlObj, init);
  if (!response.ok) {
    throw new HttpStatusError(response.status, response.statusText);
  }
  return response;
}

class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(`HTTP ${status}: ${statusText}`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

export class DuckDuckGoSearchProvider implements SearchProvider {
  readonly source = "duckduckgo" as const;
  private readonly timeoutSeconds: number;

  constructor(timeoutSeconds = 30.0) {
    this.timeoutSeconds = timeoutSeconds;
  }

  async search(query: string, maxResults = 8): Promise<SearchResult[]> {
    if (!query.trim()) {
      return [];
    }
    const retrievedAt = utcNow();
    const body = new URLSearchParams({q: query});
    const response = await fetch("https://lite.duckduckgo.com/lite/", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": SEARCH_USER_AGENT,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(this.timeoutSeconds * 1000),
    });
    if (!response.ok) {
      throw new HttpStatusError(response.status, response.statusText);
    }
    const html = await response.text();
    return parseDuckDuckGoLiteResults(html, maxResults, retrievedAt);
  }
}

export class BraveSearchProvider implements SearchProvider {
  readonly source = "brave" as const;
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly timeoutSeconds: number;

  constructor(apiKey: string, apiUrl: string, timeoutSeconds = 30.0) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
    this.timeoutSeconds = timeoutSeconds;
  }

  async search(query: string, maxResults = 8): Promise<SearchResult[]> {
    if (!query.trim()) {
      return [];
    }
    const response = await httpRequest(this.apiUrl, {
      timeoutSeconds: this.timeoutSeconds,
      params: {q: query, count: maxResults},
      headers: {
        accept: "application/json",
        "x-subscription-token": this.apiKey,
        "user-agent": SEARCH_USER_AGENT,
      },
    });
    return parseBraveWebResults((await response.json()) as JsonObject, utcNow());
  }
}

export class TavilySearchProvider implements SearchProvider {
  readonly source = "tavily" as const;
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly timeoutSeconds: number;

  constructor(apiKey: string, apiUrl: string, timeoutSeconds = 30.0) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
    this.timeoutSeconds = timeoutSeconds;
  }

  async search(query: string, maxResults = 8): Promise<SearchResult[]> {
    if (!query.trim()) {
      return [];
    }
    const response = await httpRequest(this.apiUrl, {
      timeoutSeconds: this.timeoutSeconds,
      method: "POST",
      body: {
        query,
        max_results: maxResults,
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
      },
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "user-agent": SEARCH_USER_AGENT,
      },
    });
    return parseTavilyResults((await response.json()) as JsonObject, utcNow());
  }
}

export class SerperSearchProvider implements SearchProvider {
  readonly source = "serper" as const;
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly timeoutSeconds: number;

  constructor(apiKey: string, apiUrl: string, timeoutSeconds = 30.0) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
    this.timeoutSeconds = timeoutSeconds;
  }

  async search(query: string, maxResults = 8): Promise<SearchResult[]> {
    if (!query.trim()) {
      return [];
    }
    const response = await httpRequest(this.apiUrl, {
      timeoutSeconds: this.timeoutSeconds,
      method: "POST",
      body: {q: query, num: maxResults},
      headers: {
        "x-api-key": this.apiKey,
        "content-type": "application/json",
        "user-agent": SEARCH_USER_AGENT,
      },
    });
    return parseSerperResults((await response.json()) as JsonObject, utcNow());
  }
}

export class SerpApiSearchProvider implements SearchProvider {
  readonly source = "serpapi" as const;
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly timeoutSeconds: number;

  constructor(apiKey: string, apiUrl: string, timeoutSeconds = 30.0) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
    this.timeoutSeconds = timeoutSeconds;
  }

  async search(query: string, maxResults = 8): Promise<SearchResult[]> {
    if (!query.trim()) {
      return [];
    }
    const response = await httpRequest(this.apiUrl, {
      timeoutSeconds: this.timeoutSeconds,
      params: {
        engine: "google",
        q: query,
        api_key: this.apiKey,
        num: maxResults,
      },
      headers: {"user-agent": SEARCH_USER_AGENT},
    });
    return parseSerpapiResults((await response.json()) as JsonObject, utcNow());
  }
}

export class ArxivSearchProvider implements SearchProvider {
  readonly source = "arxiv" as const;
  private readonly apiUrl: string;
  private readonly timeoutSeconds: number;

  constructor(apiUrl = ARXIV_API_URL, timeoutSeconds = 30.0) {
    this.apiUrl = apiUrl;
    this.timeoutSeconds = timeoutSeconds;
  }

  async search(
    query: string,
    maxResults = 8,
    sortBy: PaperSearchSort = "hybrid",
  ): Promise<SearchResult[]> {
    if (!query.trim()) {
      return [];
    }
    if (sortBy === "hybrid") {
      return this.hybridSearch(query, maxResults);
    }
    const apiSortBy = arxivApiSortBy(sortBy);
    return this.searchVariants(query, maxResults, apiSortBy, sortBy);
  }

  private async fetch(searchQuery: string, maxResults: number, sortBy: string): Promise<Response> {
    return httpRequest(this.apiUrl, {
      timeoutSeconds: this.timeoutSeconds,
      params: {
        search_query: searchQuery,
        start: 0,
        max_results: maxResults,
        sortBy,
        sortOrder: "descending",
      },
      headers: {"user-agent": SEARCH_USER_AGENT},
    });
  }

  private async searchVariants(
    query: string,
    maxResults: number,
    apiSortBy: string,
    requestedSort: PaperSearchSort,
  ): Promise<SearchResult[]> {
    let lastResults: SearchResult[] = [];
    for (const searchQuery of arxivSearchQueries(query)) {
      const response = await this.fetch(searchQuery, maxResults, apiSortBy);
      const parsed = parseArxivFeed(await response.text(), utcNow());
      const annotated = annotateArxivSort(parsed, requestedSort, apiSortBy, searchQuery);
      if (annotated.length > 0) {
        return annotated;
      }
      lastResults = annotated;
    }
    return lastResults;
  }

  private async hybridSearch(query: string, maxResults: number): Promise<SearchResult[]> {
    const relevanceCount = Math.max(1, Math.floor(maxResults / 2));
    const latestCount = maxResults;
    const relevanceResults = await this.searchVariants(
      query,
      relevanceCount,
      "relevance",
      "hybrid",
    );
    const latestResults = await this.searchVariants(
      query,
      latestCount,
      "submittedDate",
      "hybrid",
    );
    return mergeSearchResults([...relevanceResults, ...latestResults], maxResults);
  }
}

export class OpenAlexSearchProvider implements SearchProvider {
  readonly source = "openalex" as const;
  private readonly apiUrl: string;
  private readonly timeoutSeconds: number;

  constructor(apiUrl = OPENALEX_API_URL, timeoutSeconds = 30.0) {
    this.apiUrl = apiUrl;
    this.timeoutSeconds = timeoutSeconds;
  }

  async search(query: string, maxResults = 8): Promise<SearchResult[]> {
    if (!query.trim()) {
      return [];
    }
    const response = await httpRequest(this.apiUrl, {
      timeoutSeconds: this.timeoutSeconds,
      params: {search: query, "per-page": maxResults},
      headers: {"user-agent": SEARCH_USER_AGENT},
    });
    return parseOpenalexWorks((await response.json()) as JsonObject, query, utcNow());
  }
}

export class SearchEngine {
  private readonly providers: Map<SearchSource, SearchProvider>;
  readonly paperSources: SearchSource[];
  readonly webSources: SearchSource[];
  private readonly sourceCooldownUntil = new Map<SearchSource, number>();

  constructor(
    providers: SearchProvider[] | null = null,
    paperSources: SearchSource[] | null = null,
    webSources: SearchSource[] | null = null,
  ) {
    this.providers = new Map((providers ?? []).map((provider) => [provider.source, provider]));
    this.paperSources = paperSources ?? ["arxiv", "openalex"];
    this.webSources = webSources ?? [
      "brave",
      "tavily",
      "serper",
      "serpapi",
      "duckduckgo",
    ];
  }

  async webSearch(query: string, maxResults = 8): Promise<SearchResponse> {
    return this.searchWithSources(query, maxResults, this.webSources, "web_search");
  }

  async paperSearch(
    query: string,
    maxResults = 8,
    sources: SearchSource[] | null = null,
    sortBy: PaperSearchSort = "hybrid",
  ): Promise<SearchResponse> {
    const selectedSources = sources ?? this.paperSources;
    return this.searchWithSources(
      query,
      maxResults,
      selectedSources,
      "paper_search",
      sortBy,
    );
  }

  private async searchWithSources(
    query: string,
    maxResults: number,
    sources: SearchSource[],
    responseSource: string,
    sortBy: PaperSearchSort = "relevance",
  ): Promise<SearchResponse> {
    const normalizedLimit = Math.max(1, Math.min(maxResults, 25));
    if (!query.trim()) {
      return {
        query,
        source: responseSource,
        results: [],
        retrieved_at: utcNow(),
        error: "Empty query",
      };
    }

    const results: SearchResult[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();

    for (const source of sources) {
      const cooldownRemaining = this.cooldownRemaining(source);
      if (cooldownRemaining > 0) {
        errors.push(
          `${source}: skipped after recent rate limit (${Math.round(cooldownRemaining)}s cooldown)`,
        );
        continue;
      }
      const provider = this.providers.get(source);
      if (provider === undefined) {
        errors.push(`Search source is not configured: ${source}`);
        continue;
      }
      const remaining = normalizedLimit - results.length;
      if (remaining <= 0) {
        break;
      }
      try {
        const providerResults =
          source === "arxiv" && provider instanceof ArxivSearchProvider
            ? await provider.search(query, remaining, sortBy)
            : await provider.search(query, remaining);
        for (const result of providerResults) {
          const key = dedupeKey(result);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          results.push(result);
          if (results.length >= normalizedLimit) {
            break;
          }
        }
      } catch (error) {
        errors.push(`${source}: ${String(error)}`);
        if (isRateLimitError(error)) {
          this.sourceCooldownUntil.set(
            source,
            performance.now() / 1000 + SOURCE_RATE_LIMIT_COOLDOWN_SECONDS,
          );
        }
      }
    }

    return {
      query,
      source: responseSource,
      results,
      retrieved_at: utcNow(),
      error: errors.length > 0 ? errors.join(" | ") : null,
    };
  }

  private cooldownRemaining(source: SearchSource): number {
    const until = this.sourceCooldownUntil.get(source) ?? 0;
    return Math.max(0, until - performance.now() / 1000);
  }
}

export function createDefaultSearchEngine(
  searchConfig: SearchConfig | null = null,
  env: Readonly<Record<string, string>> | null = null,
): SearchEngine {
  if (searchConfig === null) {
    return new SearchEngine([
      new ArxivSearchProvider(),
      new OpenAlexSearchProvider(),
      new DuckDuckGoSearchProvider(),
    ]);
  }

  const providers: SearchProvider[] = [];
  for (const [source, providerConfig] of Object.entries(searchConfig.providers) as [
    SearchSource,
    (typeof searchConfig.providers)[SearchSource],
  ][]) {
    if (!providerConfig.enabled) {
      continue;
    }
    if (source === "arxiv" && providerConfig.base_url) {
      providers.push(
        new ArxivSearchProvider(
          providerConfig.base_url,
          searchConfig.timeout_seconds,
        ),
      );
    } else if (source === "openalex" && providerConfig.base_url) {
      providers.push(
        new OpenAlexSearchProvider(
          providerConfig.base_url,
          searchConfig.timeout_seconds,
        ),
      );
    } else if (source === "duckduckgo") {
      providers.push(new DuckDuckGoSearchProvider(searchConfig.timeout_seconds));
    } else if (source === "brave" && providerConfig.base_url) {
      const apiKey = searchApiKey(providerConfig.api_key_env, env);
      if (apiKey) {
        providers.push(
          new BraveSearchProvider(
            apiKey,
            providerConfig.base_url,
            searchConfig.timeout_seconds,
          ),
        );
      }
    } else if (source === "tavily" && providerConfig.base_url) {
      const apiKey = searchApiKey(providerConfig.api_key_env, env);
      if (apiKey) {
        providers.push(
          new TavilySearchProvider(
            apiKey,
            providerConfig.base_url,
            searchConfig.timeout_seconds,
          ),
        );
      }
    } else if (source === "serper" && providerConfig.base_url) {
      const apiKey = searchApiKey(providerConfig.api_key_env, env);
      if (apiKey) {
        providers.push(
          new SerperSearchProvider(
            apiKey,
            providerConfig.base_url,
            searchConfig.timeout_seconds,
          ),
        );
      }
    } else if (source === "serpapi" && providerConfig.base_url) {
      const apiKey = searchApiKey(providerConfig.api_key_env, env);
      if (apiKey) {
        providers.push(
          new SerpApiSearchProvider(
            apiKey,
            providerConfig.base_url,
            searchConfig.timeout_seconds,
          ),
        );
      }
    }
  }

  const configuredSources = new Set(providers.map((provider) => provider.source));
  return new SearchEngine(
    providers,
    searchConfig.paper_sources.filter((source) => configuredSources.has(source)),
    searchConfig.web_sources.filter((source) => configuredSources.has(source)),
  );
}

export function arxivSearchQuery(query: string): string {
  const queries = arxivSearchQueries(query);
  return queries[0] ?? "";
}

export function arxivSearchQueries(query: string): string[] {
  const normalized = query.trim().split(/\s+/).join(" ");
  if (!normalized) {
    return [];
  }
  if (looksLikeArxivAdvancedQuery(normalized)) {
    return [normalized];
  }
  const terms = normalized
    .split(/\s+/)
    .map((term) => term.replace(/[^A-Za-z0-9_.-]/g, ""))
    .filter(Boolean);
  if (terms.length === 0) {
    return [`all:"${normalized}"`];
  }
  const variants = [terms.slice(0, 8).map((term) => `all:${term}`).join(" AND ")];
  if (terms.length > 4) {
    variants.push(terms.slice(0, 4).map((term) => `all:${term}`).join(" AND "));
  }
  if (terms.length > 3) {
    variants.push(terms.slice(0, 3).map((term) => `all:${term}`).join(" AND "));
  }
  if (terms.length > 2) {
    variants.push(terms.slice(-3).map((term) => `all:${term}`).join(" AND "));
  }
  const deduped: string[] = [];
  for (const variant of variants) {
    if (variant && !deduped.includes(variant)) {
      deduped.push(variant);
    }
  }
  return deduped;
}

export function arxivApiSortBy(sortBy: PaperSearchSort): string {
  if (sortBy === "submitted_date") {
    return "submittedDate";
  }
  return "relevance";
}

function annotateArxivSort(
  results: SearchResult[],
  requestedSort: PaperSearchSort,
  apiSort: string,
  arxivQuery: string | null = null,
): SearchResult[] {
  return results.map((result) => ({
    ...result,
    metadata: {
      ...result.metadata,
      requested_sort: requestedSort,
      api_sort: apiSort,
      arxiv_query: arxivQuery,
    },
  }));
}

function mergeSearchResults(results: SearchResult[], maxResults: number): SearchResult[] {
  const merged: SearchResult[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    const key = dedupeKey(result);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(result);
    if (merged.length >= maxResults) {
      break;
    }
  }
  return merged;
}

export function parseArxivFeed(feedText: string, retrievedAt?: string): SearchResult[] {
  const timestamp = retrievedAt ?? utcNow();
  const results: SearchResult[] = [];
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(feedText)) !== null) {
    const entry = match[1];
    const title = extractTagText(entry, "title");
    const summary = extractTagText(entry, "summary");
    const url = extractTagText(entry, "id");
    const pdfUrl = extractArxivPdfUrl(entry);
    const authors = extractAuthorNames(entry);
    const externalId = url ? url.replace(/\/$/, "").split("/").pop() ?? null : null;
    const categories = [...entry.matchAll(/<category[^>]*term="([^"]+)"/g)].map(
      (categoryMatch) => categoryMatch[1],
    );
    const primaryCategoryMatch = entry.match(/<arxiv:primary_category[^>]*term="([^"]+)"/);
    const doi = extractTagText(entry, "arxiv:doi");
    const journalRef = extractTagText(entry, "arxiv:journal_ref");
    const comment = extractTagText(entry, "arxiv:comment");
    if (title && url) {
      results.push({
        source: "arxiv",
        title,
        snippet: summary,
        url,
        retrieved_at: timestamp,
        external_id: externalId,
        authors,
        published_at: extractTagText(entry, "published") || null,
        updated_at: extractTagText(entry, "updated") || null,
        pdf_url: pdfUrl,
        metadata: {
          backend: "arxiv",
          primary_category: primaryCategoryMatch?.[1] ?? null,
          categories,
          doi: doi || null,
          journal_ref: journalRef || null,
          comment: comment || null,
        },
      });
    }
  }
  return results;
}

export function parseOpenalexWorks(
  payload: JsonObject,
  query: string,
  retrievedAt?: string,
): SearchResult[] {
  const timestamp = retrievedAt ?? utcNow();
  const rawResults = payload.results;
  if (!Array.isArray(rawResults)) {
    return [];
  }
  const results: SearchResult[] = [];
  for (const rawItem of rawResults) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      continue;
    }
    const item = rawItem as JsonObject;
    const title = String(item.title ?? item.display_name ?? "").trim();
    const url = openalexLandingUrl(item);
    if (!title || !url) {
      continue;
    }
    const openalexId = String(item.id ?? "");
    const doi = item.doi;
    const authors = openalexAuthors(item);
    const abstract = abstractFromOpenalex(item.abstract_inverted_index);
    const pdfUrl = openalexPdfUrl(item);
    results.push({
      source: "openalex",
      title,
      snippet: abstract,
      url,
      retrieved_at: timestamp,
      external_id: openalexId ? openalexId.split("/").pop() ?? null : null,
      authors,
      published_at: String(item.publication_date ?? "") || null,
      updated_at: String(item.updated_date ?? "") || null,
      pdf_url: pdfUrl,
      metadata: {
        backend: "openalex",
        query,
        doi: typeof doi === "string" ? doi : null,
        cited_by_count: item.cited_by_count,
        publication_year: item.publication_year,
        openalex_id: openalexId || null,
      },
    });
  }
  return results;
}

export function parseBraveWebResults(
  payload: JsonObject,
  retrievedAt?: string,
): SearchResult[] {
  const timestamp = retrievedAt ?? utcNow();
  const web = payload.web;
  const rawResults =
    web && typeof web === "object" && !Array.isArray(web)
      ? (web as JsonObject).results
      : [];
  if (!Array.isArray(rawResults)) {
    return [];
  }
  const results: SearchResult[] = [];
  for (const rawItem of rawResults) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      continue;
    }
    const item = rawItem as JsonObject;
    const title = String(item.title ?? "").trim();
    const url = String(item.url ?? "").trim();
    if (!title || !url) {
      continue;
    }
    results.push({
      source: "brave",
      title,
      snippet: String(item.description ?? ""),
      url,
      retrieved_at: timestamp,
      authors: [],
      metadata: {backend: "brave", age: item.age},
    });
  }
  return results;
}

export function parseTavilyResults(payload: JsonObject, retrievedAt?: string): SearchResult[] {
  const timestamp = retrievedAt ?? utcNow();
  const rawResults = payload.results;
  if (!Array.isArray(rawResults)) {
    return [];
  }
  const results: SearchResult[] = [];
  for (const rawItem of rawResults) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      continue;
    }
    const item = rawItem as JsonObject;
    const title = String(item.title ?? "").trim();
    const url = String(item.url ?? "").trim();
    if (!title || !url) {
      continue;
    }
    results.push({
      source: "tavily",
      title,
      snippet: String(item.content ?? ""),
      url,
      retrieved_at: timestamp,
      authors: [],
      metadata: {backend: "tavily", score: item.score},
    });
  }
  return results;
}

export function parseSerperResults(payload: JsonObject, retrievedAt?: string): SearchResult[] {
  const timestamp = retrievedAt ?? utcNow();
  const rawResults = payload.organic;
  if (!Array.isArray(rawResults)) {
    return [];
  }
  const results: SearchResult[] = [];
  for (const rawItem of rawResults) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      continue;
    }
    const item = rawItem as JsonObject;
    const title = String(item.title ?? "").trim();
    const url = String(item.link ?? "").trim();
    if (!title || !url) {
      continue;
    }
    results.push({
      source: "serper",
      title,
      snippet: String(item.snippet ?? ""),
      url,
      retrieved_at: timestamp,
      authors: [],
      metadata: {
        backend: "serper",
        position: item.position,
        date: item.date,
      },
    });
  }
  return results;
}

export function parseSerpapiResults(payload: JsonObject, retrievedAt?: string): SearchResult[] {
  const timestamp = retrievedAt ?? utcNow();
  const rawResults = payload.organic_results;
  if (!Array.isArray(rawResults)) {
    return [];
  }
  const results: SearchResult[] = [];
  for (const rawItem of rawResults) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      continue;
    }
    const item = rawItem as JsonObject;
    const title = String(item.title ?? "").trim();
    const url = String(item.link ?? "").trim();
    if (!title || !url) {
      continue;
    }
    results.push({
      source: "serpapi",
      title,
      snippet: String(item.snippet ?? ""),
      url,
      retrieved_at: timestamp,
      authors: [],
      metadata: {
        backend: "serpapi",
        position: item.position,
        displayed_link: item.displayed_link,
      },
    });
  }
  return results;
}

function parseDuckDuckGoLiteResults(
  html: string,
  maxResults: number,
  retrievedAt: string,
): SearchResult[] {
  const results: SearchResult[] = [];
  const rowPattern =
    /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;
  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(html)) !== null && results.length < maxResults) {
    const url = decodeHtmlEntities(match[1].trim());
    const title = stripHtml(decodeHtmlEntities(match[2].trim()));
    const snippet = stripHtml(decodeHtmlEntities(match[3].trim()));
    if (!url) {
      continue;
    }
    results.push({
      source: "duckduckgo",
      title,
      snippet,
      url,
      retrieved_at: retrievedAt,
      authors: [],
      metadata: {backend: "duckduckgo"},
    });
  }
  return results;
}

function looksLikeArxivAdvancedQuery(query: string): boolean {
  return /\b(?:ti|au|abs|co|jr|cat|rn|id|all):/.test(query);
}

function normalizeWs(text: string): string {
  return text.trim().split(/\s+/).join(" ");
}

function extractTagText(entry: string, tag: string): string {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = entry.match(pattern);
  return match ? normalizeWs(match[1]) : "";
}

function extractAuthorNames(entry: string): string[] {
  const authors: string[] = [];
  const authorPattern = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g;
  let match: RegExpExecArray | null;
  while ((match = authorPattern.exec(entry)) !== null) {
    const name = normalizeWs(match[1]);
    if (name) {
      authors.push(name);
    }
  }
  return authors;
}

function extractArxivPdfUrl(entry: string): string | null {
  const linkPattern = /<link[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(entry)) !== null) {
    const linkTag = match[0];
    if (/title="pdf"/i.test(linkTag)) {
      const hrefMatch = linkTag.match(/href="([^"]+)"/i);
      if (hrefMatch) {
        return hrefMatch[1];
      }
    }
  }
  return null;
}

function dedupeKey(result: SearchResult): string {
  if (result.external_id) {
    return result.external_id;
  }
  return result.url || `${result.source}:${result.title}`;
}

function isRateLimitError(error: unknown): boolean {
  if (error instanceof HttpStatusError && error.status === 429) {
    return true;
  }
  return String(error).includes("429");
}

function searchApiKey(
  apiKeyEnv: string | null,
  env: Readonly<Record<string, string>> | null,
): string | null {
  if (!apiKeyEnv || env === null) {
    return null;
  }
  const value = env[apiKeyEnv];
  return value ? value : null;
}

function openalexLandingUrl(item: JsonObject): string {
  const primaryLocation = item.primary_location;
  if (primaryLocation && typeof primaryLocation === "object" && !Array.isArray(primaryLocation)) {
    const landingPageUrl = (primaryLocation as JsonObject).landing_page_url;
    if (typeof landingPageUrl === "string" && landingPageUrl) {
      return landingPageUrl;
    }
  }
  const doi = item.doi;
  if (typeof doi === "string" && doi) {
    return doi;
  }
  return String(item.id ?? "");
}

function openalexPdfUrl(item: JsonObject): string | null {
  const primaryLocation = item.primary_location;
  if (primaryLocation && typeof primaryLocation === "object" && !Array.isArray(primaryLocation)) {
    const pdfUrl = (primaryLocation as JsonObject).pdf_url;
    if (typeof pdfUrl === "string" && pdfUrl) {
      return pdfUrl;
    }
  }
  return null;
}

function openalexAuthors(item: JsonObject): string[] {
  const authorships = item.authorships;
  if (!Array.isArray(authorships)) {
    return [];
  }
  const authors: string[] = [];
  for (const authorship of authorships) {
    if (!authorship || typeof authorship !== "object" || Array.isArray(authorship)) {
      continue;
    }
    const author = (authorship as JsonObject).author;
    if (author && typeof author === "object" && !Array.isArray(author)) {
      const name = (author as JsonObject).display_name;
      if (typeof name === "string" && name) {
        authors.push(name);
      }
    }
  }
  return authors;
}

function abstractFromOpenalex(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const positions = new Map<number, string>();
  for (const [word, rawIndexes] of Object.entries(value as Record<string, unknown>)) {
    if (typeof word !== "string" || !Array.isArray(rawIndexes)) {
      continue;
    }
    for (const rawIndex of rawIndexes) {
      if (typeof rawIndex === "number") {
        positions.set(rawIndex, word);
      }
    }
  }
  return [...positions.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, word]) => word)
    .join(" ");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(text: string): string {
  return normalizeWs(text.replace(/<[^>]+>/g, " "));
}
