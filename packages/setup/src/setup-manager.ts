import {randomBytes} from "node:crypto";

import {
  AgentConfig,
  DEFAULT_SEARCH_API_KEY_ENVS,
  loadMergedEnv,
} from "@academic-agent/config";
import {verifyLlmConnection} from "@academic-agent/providers";
import type {
  SearchSource,
  SetupApplyRequest,
  SetupApplyResponse,
  SetupKeyedSearchSource,
  SetupLlmCandidate,
  SetupSearchStatus,
  SetupStatusResponse,
  SetupVerifyErrorCategory,
  SetupVerifyLlmRequest,
  SetupVerifyLlmResponse,
  SetupVerifySearchRequest,
  SetupVerifySearchResponse,
} from "@academic-agent/schemas";
import {
  BraveSearchProvider,
  SerpApiSearchProvider,
  SerperSearchProvider,
  TavilySearchProvider,
} from "@academic-agent/search";

import {
  KEYED_SEARCH_SOURCES,
  PROVIDER_OPTIONS,
  SEARCH_LABELS,
  candidateHash,
  searchCandidateHash,
  secretFingerprint,
} from "./options.js";
import {applySetupConfiguration, readStoredApiKey} from "./persistence.js";

const VERIFICATION_TTL_MS = 5 * 60 * 1000;

type VerificationKind = "llm" | "search";

interface VerificationSession {
  verification_id: string;
  kind: VerificationKind;
  candidate_hash: string;
  secret_fingerprint: string;
  expires_at: number;
}

export type LlmVerifier = (
  candidate: SetupLlmCandidate,
  apiKey: string,
) => Promise<{verified: boolean; category?: SetupVerifyErrorCategory; message?: string}>;

export type SearchVerifier = (
  source: SetupKeyedSearchSource,
  apiKey: string,
) => Promise<{verified: boolean; category?: SetupVerifyErrorCategory; message?: string}>;

export class SetupManager {
  private readonly verifications = new Map<string, VerificationSession>();
  private readonly llmVerifier: LlmVerifier;
  private readonly searchVerifier: SearchVerifier;
  private readonly now: () => number;

  constructor(
    readonly projectRoot: string,
    options?: {
      llmVerifier?: LlmVerifier;
      searchVerifier?: SearchVerifier;
      now?: () => number;
      env?: Record<string, string>;
    },
  ) {
    this.llmVerifier =
      options?.llmVerifier ??
      (async (candidate, apiKey) => {
        const result = await verifyLlmConnection(candidate, apiKey);
        return result.ok
          ? {verified: true}
          : {verified: false, category: result.category, message: result.message};
      });
    this.searchVerifier =
      options?.searchVerifier ??
      (async (source, apiKey) => verifySearchConnection(source, apiKey));
    this.now = options?.now ?? (() => Date.now());
    this.runtimeEnv = options?.env;
  }

  private readonly runtimeEnv?: Record<string, string>;

  private env(): Record<string, string> {
    return loadMergedEnv(this.projectRoot, this.runtimeEnv);
  }

  private purgeExpired(): void {
    const current = this.now();
    for (const [id, session] of this.verifications.entries()) {
      if (session.expires_at <= current) {
        this.verifications.delete(id);
      }
    }
  }

  private createSession(kind: VerificationKind, candidateHashValue: string, secret: string): string {
    this.purgeExpired();
    const verification_id = randomBytes(24).toString("base64url");
    this.verifications.set(verification_id, {
      verification_id,
      kind,
      candidate_hash: candidateHashValue,
      secret_fingerprint: secretFingerprint(secret),
      expires_at: this.now() + VERIFICATION_TTL_MS,
    });
    return verification_id;
  }

  private consumeSession(
    verificationId: string,
    kind: VerificationKind,
    candidateHashValue: string,
    secret: string,
  ): void {
    this.purgeExpired();
    const session = this.verifications.get(verificationId);
    if (!session) {
      throw new SetupConflictError("Verification expired or not found");
    }
    if (session.kind !== kind) {
      throw new SetupConflictError("Verification kind mismatch");
    }
    if (session.candidate_hash !== candidateHashValue) {
      throw new SetupConflictError("Verification does not match candidate");
    }
    if (session.secret_fingerprint !== secretFingerprint(secret)) {
      throw new SetupConflictError("Verification does not match credentials");
    }
    this.verifications.delete(verificationId);
  }

  status(): SetupStatusResponse {
    const config = AgentConfig.load(this.projectRoot, this.env());
    const state = config.setup_state();
    const planner = config.planner_or_none();
    const plannerCandidate =
      planner && planner.provider !== "mock"
        ? {
            provider: planner.provider as SetupLlmCandidate["provider"],
            model: planner.model,
            base_url: planner.base_url ?? null,
            api_key_env: planner.api_key_env ?? "",
          }
        : null;
    const hasApiKey = Boolean(
      plannerCandidate?.api_key_env && config.env[plannerCandidate.api_key_env],
    );
    return {
      state,
      setup_required: state !== "configured",
      planner: plannerCandidate,
      has_api_key: hasApiKey,
      provider_options: PROVIDER_OPTIONS,
      search: this.searchStatuses(config),
    };
  }

  private searchStatuses(config: AgentConfig): SetupSearchStatus[] {
    const statuses: SetupSearchStatus[] = [
      {
        source: "arxiv",
        label: "arXiv",
        keyed: false,
        configured: true,
        has_api_key: false,
        enabled: config.search.paper_sources.includes("arxiv"),
        verification_required: false,
      },
      {
        source: "openalex",
        label: "OpenAlex",
        keyed: false,
        configured: true,
        has_api_key: false,
        enabled: config.search.paper_sources.includes("openalex"),
        verification_required: false,
      },
      {
        source: "duckduckgo",
        label: "DuckDuckGo",
        keyed: false,
        configured: true,
        has_api_key: false,
        enabled: config.search.web_sources.includes("duckduckgo"),
        verification_required: false,
      },
    ];
    for (const source of KEYED_SEARCH_SOURCES) {
      const provider = config.search.providers[source];
      const apiKeyEnv = provider.api_key_env ?? DEFAULT_SEARCH_API_KEY_ENVS[source];
      const hasApiKey = Boolean(apiKeyEnv && config.env[apiKeyEnv]);
      statuses.push({
        source,
        label: SEARCH_LABELS[source],
        keyed: true,
        configured: hasApiKey,
        has_api_key: hasApiKey,
        enabled: config.search.web_sources.includes(source),
        verification_required: true,
      });
    }
    return statuses;
  }

  async verifyLlm(request: SetupVerifyLlmRequest): Promise<SetupVerifyLlmResponse> {
    const env = this.env();
    const apiKey = request.use_stored_key
      ? readStoredApiKey(env, request.candidate.api_key_env)
      : request.api_key ?? null;
    if (!apiKey) {
      return {
        verified: false,
        error_category: "authentication_failed",
        message: "API key is required",
      };
    }
    const result = await this.llmVerifier(request.candidate, apiKey);
    if (!result.verified) {
      return {
        verified: false,
        error_category: result.category ?? "provider_error",
        message: result.message ?? "Verification failed",
      };
    }
    const verification_id = this.createSession("llm", candidateHash(request.candidate), apiKey);
    return {verified: true, verification_id};
  }

  async verifySearch(request: SetupVerifySearchRequest): Promise<SetupVerifySearchResponse> {
    const env = this.env();
    const apiKeyEnv = DEFAULT_SEARCH_API_KEY_ENVS[request.source] ?? `${request.source.toUpperCase()}_API_KEY`;
    const apiKey = request.use_stored_key
      ? readStoredApiKey(env, apiKeyEnv)
      : request.api_key ?? null;
    if (!apiKey) {
      return {
        verified: false,
        error_category: "authentication_failed",
        message: "API key is required",
      };
    }
    const result = await this.searchVerifier(request.source, apiKey);
    if (!result.verified) {
      return {
        verified: false,
        error_category: result.category ?? "provider_error",
        message: result.message ?? "Verification failed",
      };
    }
    const verification_id = this.createSession(
      "search",
      searchCandidateHash(request.source),
      apiKey,
    );
    return {verified: true, verification_id};
  }

  apply(request: SetupApplyRequest): SetupApplyResponse {
    const env = this.env();
    const apiKey = request.use_stored_key
      ? readStoredApiKey(env, request.candidate.api_key_env)
      : request.api_key ?? null;
    if (!apiKey) {
      throw new SetupConflictError("API key is required to apply setup");
    }
    this.consumeSession(
      request.llm_verification_id,
      "llm",
      candidateHash(request.candidate),
      apiKey,
    );

    const enabledSearch = new Set<SearchSource>(["arxiv", "openalex", "duckduckgo"]);
    const nextEnv = {...env, [request.candidate.api_key_env]: apiKey};
    for (const source of request.enabled_search_sources) {
      if (!KEYED_SEARCH_SOURCES.includes(source as SetupKeyedSearchSource)) {
        continue;
      }
      const keyedSource = source as SetupKeyedSearchSource;
      const verificationId = request.search_verification_ids[source];
      if (!verificationId) {
        continue;
      }
      const apiKeyEnv = DEFAULT_SEARCH_API_KEY_ENVS[keyedSource];
      const searchKey =
        request.search_api_keys[source] ??
        (request.use_stored_key ? readStoredApiKey(env, apiKeyEnv ?? "") : null);
      if (!searchKey) {
        throw new SetupConflictError(`Missing API key for ${source}`);
      }
      this.consumeSession(verificationId, "search", searchCandidateHash(keyedSource), searchKey);
      if (apiKeyEnv) {
        nextEnv[apiKeyEnv] = searchKey;
      }
      enabledSearch.add(source);
    }

    applySetupConfiguration({
      projectRoot: this.projectRoot,
      env: nextEnv,
      candidate: request.candidate,
      apiKey,
      enabledSearchSources: [...enabledSearch],
    });

    return this.status();
  }
}

export class SetupConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupConflictError";
  }
}

async function verifySearchConnection(
  source: SetupKeyedSearchSource,
  apiKey: string,
): Promise<{verified: boolean; category?: SetupVerifyErrorCategory; message?: string}> {
  try {
    const query = "academic research";
    if (source === "brave") {
      const provider = new BraveSearchProvider(apiKey, "https://api.search.brave.com/res/v1/web/search", 10);
      await provider.search(query, 1);
      return {verified: true};
    }
    if (source === "tavily") {
      const provider = new TavilySearchProvider(apiKey, "https://api.tavily.com/search", 10);
      await provider.search(query, 1);
      return {verified: true};
    }
    if (source === "serper") {
      const provider = new SerperSearchProvider(apiKey, "https://google.serper.dev/search", 10);
      await provider.search(query, 1);
      return {verified: true};
    }
    const provider = new SerpApiSearchProvider(apiKey, "https://serpapi.com/search.json", 10);
    await provider.search(query, 1);
    return {verified: true};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("401")) {
      return {verified: false, category: "authentication_failed", message: "Authentication failed"};
    }
    if (message.includes("429")) {
      return {verified: false, category: "rate_limited", message: "Rate limited"};
    }
    if (error instanceof Error && error.name === "AbortError") {
      return {verified: false, category: "timeout", message: "Connection timed out"};
    }
    return {verified: false, category: "provider_error", message: "Search verification failed"};
  }
}
