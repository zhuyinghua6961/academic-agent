import type {PaperSearchSort, SearchSource, ToolDefinition} from "@academic-agent/schemas";

import {createDefaultSearchEngine, type SearchEngine} from "./search.js";

const SEARCH_SOURCE_VALUES = new Set<SearchSource>([
  "arxiv",
  "openalex",
  "brave",
  "tavily",
  "serper",
  "serpapi",
  "duckduckgo",
]);

export interface ToolExecutor {
  readonly definition: ToolDefinition;
  execute(arguments_: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolExecutor>();

  register(executor: ToolExecutor): void {
    this.tools.set(executor.definition.name, executor);
  }

  getAllDefinitions(): Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }> {
    return [...this.tools.values()].map((executor) => ({
      type: "function" as const,
      function: {
        name: executor.definition.name,
        description: executor.definition.description,
        parameters: executor.definition.parameters,
      },
    }));
  }

  async execute(name: string, arguments_: Record<string, unknown>): Promise<Record<string, unknown>> {
    const executor = this.tools.get(name);
    if (executor === undefined) {
      return {error: `Unknown tool: ${name}`};
    }
    try {
      return await executor.execute(arguments_);
    } catch (error) {
      return {error: String(error)};
    }
  }

  get size(): number {
    return this.tools.size;
  }
}

export class WebSearchTool implements ToolExecutor {
  readonly definition: ToolDefinition;
  private readonly searchEngine: SearchEngine;

  constructor(searchEngine: SearchEngine) {
    this.searchEngine = searchEngine;
    this.definition = {
      name: "web_search",
      description:
        "Search the open web for technical information. This is a fallback " +
        "tool; use paper_search first when the task is about academic literature.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query. Use academic terminology.",
          },
          max_results: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description: "Maximum number of results to return.",
          },
        },
        required: ["query"],
      },
    };
  }

  async execute(arguments_: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = String(arguments_.query ?? "");
    if (!query.trim()) {
      return {error: "Empty query", results: []};
    }
    const maxResults = boundedInt(arguments_.max_results, 8, 1, 10);
    const response = await this.searchEngine.webSearch(query, maxResults);
    return response as unknown as Record<string, unknown>;
  }
}

export class PaperSearchTool implements ToolExecutor {
  readonly definition: ToolDefinition;
  private readonly searchEngine: SearchEngine;

  constructor(searchEngine: SearchEngine) {
    this.searchEngine = searchEngine;
    this.definition = {
      name: "paper_search",
      description:
        "Search academic literature for related work and nearby papers. " +
        "Use this before web_search when diagnosing novelty or research gaps. " +
        "Returns structured paper metadata, abstracts/snippets, URLs, and source names.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Academic query using task, method, or problem keywords.",
          },
          max_results: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description: "Maximum number of papers to return.",
          },
          sources: {
            type: "array",
            items: {
              type: "string",
              enum: [...SEARCH_SOURCE_VALUES],
            },
            description:
              "Search sources in priority order. Defaults to arxiv, openalex, then web.",
          },
          sort_by: {
            type: "string",
            enum: ["hybrid", "relevance", "submitted_date"],
            description:
              "Paper ordering strategy. Use hybrid by default so arXiv returns both " +
              "relevant papers and newly submitted preprints. Use submitted_date " +
              "when the user asks for latest/recent/current preprints.",
          },
        },
        required: ["query"],
      },
    };
  }

  async execute(arguments_: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = String(arguments_.query ?? "");
    if (!query.trim()) {
      return {error: "Empty query", results: []};
    }
    const maxResults = boundedInt(arguments_.max_results, 8, 1, 10);
    const sources = searchSources(arguments_.sources);
    const sortBy = paperSearchSort(arguments_.sort_by);
    const response = await this.searchEngine.paperSearch(
      query,
      maxResults,
      sources,
      sortBy,
    );
    return response as unknown as Record<string, unknown>;
  }
}

export function getDefaultTools(searchEngine: SearchEngine | null = null): ToolRegistry {
  const engine = searchEngine ?? createDefaultSearchEngine();
  const registry = new ToolRegistry();
  registry.register(new PaperSearchTool(engine));
  registry.register(new WebSearchTool(engine));
  return registry;
}

function boundedInt(value: unknown, defaultValue: number, lower: number, upper: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const resolved = Number.isNaN(parsed) ? defaultValue : parsed;
  return Math.max(lower, Math.min(resolved, upper));
}

function searchSources(value: unknown): SearchSource[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const sources = value.filter(
    (item): item is SearchSource =>
      typeof item === "string" && SEARCH_SOURCE_VALUES.has(item as SearchSource),
  );
  return sources.length > 0 ? sources : null;
}

function paperSearchSort(value: unknown): PaperSearchSort {
  if (value === "relevance") {
    return "relevance";
  }
  if (value === "submitted_date") {
    return "submitted_date";
  }
  return "hybrid";
}
