import type {
  SetupKeyedSearchSource,
  SetupLlmCandidate,
  SetupProviderName,
  SetupStatusResponse,
} from "@academic-agent/schemas";

export type SetupStep = "provider" | "llm" | "search" | "review" | "saving" | "done";
export type VerificationState = "idle" | "verifying" | "verified" | "failed";

export type SetupWizardState = {
  step: SetupStep;
  status: SetupStatusResponse;
  provider: SetupProviderName;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  apiKey: string;
  useStoredKey: boolean;
  llmVerification: VerificationState;
  llmVerificationId: string | null;
  llmError: string | null;
  selectedSearchIndex: number;
  searchKeys: Partial<Record<SetupKeyedSearchSource, string>>;
  searchVerification: Partial<
    Record<SetupKeyedSearchSource, {state: VerificationState; id: string | null; error?: string}>
  >;
  enabledSearch: SetupKeyedSearchSource[];
  selectedProviderIndex: number;
  fieldFocus: "model" | "baseUrl" | "apiKey";
  busy: boolean;
  error: string | null;
};

export type SetupAction =
  | {type: "reset"; status: SetupStatusResponse; reconfigure?: boolean}
  | {type: "select-provider-index"; index: number}
  | {type: "confirm-provider"}
  | {type: "set-model"; value: string}
  | {type: "set-base-url"; value: string}
  | {type: "set-api-key"; value: string}
  | {type: "toggle-use-stored-key"}
  | {type: "focus-next-field"}
  | {type: "focus-prev-field"}
  | {type: "begin-llm-verify"}
  | {type: "llm-verify-success"; verificationId: string}
  | {type: "llm-verify-failed"; message: string}
  | {type: "continue-to-search"}
  | {type: "back"}
  | {type: "select-search-index"; index: number}
  | {type: "set-search-key"; source: SetupKeyedSearchSource; value: string}
  | {type: "begin-search-verify"; source: SetupKeyedSearchSource}
  | {type: "search-verify-success"; source: SetupKeyedSearchSource; verificationId: string}
  | {type: "search-verify-failed"; source: SetupKeyedSearchSource; message: string}
  | {type: "toggle-search-enabled"; source: SetupKeyedSearchSource}
  | {type: "skip-search"}
  | {type: "begin-apply"}
  | {type: "apply-success"; status: SetupStatusResponse}
  | {type: "apply-failed"; message: string}
  | {type: "set-error"; message: string}
  | {type: "clear-error"};

const KEYED_SEARCH: SetupKeyedSearchSource[] = ["brave", "tavily", "serper", "serpapi"];

function defaultProviderIndex(status: SetupStatusResponse): number {
  const planner = status.planner;
  if (!planner) {
    return 0;
  }
  const index = status.provider_options.findIndex((item) => item.provider === planner.provider);
  return index >= 0 ? index : 0;
}

function optionForProvider(
  status: SetupStatusResponse,
  provider: SetupProviderName,
): SetupStatusResponse["provider_options"][number] {
  return (
    status.provider_options.find((item) => item.provider === provider) ??
    status.provider_options[0]!
  );
}

export function initialSetupState(
  status: SetupStatusResponse,
  options?: {reconfigure?: boolean},
): SetupWizardState {
  const reconfigure = options?.reconfigure ?? false;
  const providerIndex = defaultProviderIndex(status);
  const option = status.provider_options[providerIndex] ?? status.provider_options[0]!;
  const planner = status.planner;
  const shouldRunWizard = status.setup_required || reconfigure;
  return {
    step: shouldRunWizard ? "provider" : "done",
    status,
    provider: planner?.provider ?? option.provider,
    model: planner?.model ?? option.default_model,
    baseUrl: planner?.base_url ?? option.default_base_url ?? "",
    apiKeyEnv: planner?.api_key_env ?? option.default_api_key_env,
    apiKey: "",
    useStoredKey: status.has_api_key,
    llmVerification: shouldRunWizard && reconfigure ? "idle" : status.has_api_key ? "verified" : "idle",
    llmVerificationId: null,
    llmError: null,
    selectedSearchIndex: 0,
    searchKeys: {},
    searchVerification: {},
    enabledSearch: [],
    selectedProviderIndex: providerIndex,
    fieldFocus: "apiKey",
    busy: false,
    error: null,
  };
}

function clearLlmVerification(state: SetupWizardState): SetupWizardState {
  return {
    ...state,
    llmVerification: "idle",
    llmVerificationId: null,
    llmError: null,
  };
}

export function buildLlmCandidate(state: SetupWizardState): SetupLlmCandidate {
  return {
    provider: state.provider,
    model: state.model.trim(),
    base_url: state.baseUrl.trim() ? state.baseUrl.trim() : null,
    api_key_env: state.apiKeyEnv,
  };
}

export function setupReducer(state: SetupWizardState, action: SetupAction): SetupWizardState {
  switch (action.type) {
    case "reset":
      return initialSetupState(action.status, {reconfigure: action.reconfigure});
    case "select-provider-index":
      return {
        ...state,
        selectedProviderIndex: action.index,
        error: null,
      };
    case "confirm-provider": {
      const selected = state.status.provider_options[state.selectedProviderIndex]!;
      return {
        ...clearLlmVerification(state),
        step: "llm",
        provider: selected.provider,
        model: selected.default_model,
        baseUrl: selected.default_base_url ?? "",
        apiKeyEnv: selected.default_api_key_env,
        apiKey: "",
        useStoredKey: false,
        fieldFocus: selected.requires_base_url ? "baseUrl" : "apiKey",
        error: null,
      };
    }
    case "set-model":
      return clearLlmVerification({...state, model: action.value, error: null});
    case "set-base-url":
      return clearLlmVerification({...state, baseUrl: action.value, error: null});
    case "set-api-key":
      return clearLlmVerification({
        ...state,
        apiKey: action.value,
        useStoredKey: false,
        error: null,
      });
    case "toggle-use-stored-key":
      return clearLlmVerification({
        ...state,
        useStoredKey: !state.useStoredKey,
        apiKey: state.useStoredKey ? state.apiKey : "",
        error: null,
      });
    case "focus-next-field": {
      const option = optionForProvider(state.status, state.provider);
      if (state.fieldFocus === "model") {
        return {...state, fieldFocus: option.requires_base_url ? "baseUrl" : "apiKey"};
      }
      if (state.fieldFocus === "baseUrl") {
        return {...state, fieldFocus: "apiKey"};
      }
      return state;
    }
    case "focus-prev-field": {
      const option = optionForProvider(state.status, state.provider);
      if (state.fieldFocus === "apiKey") {
        return {...state, fieldFocus: option.requires_base_url ? "baseUrl" : "model"};
      }
      if (state.fieldFocus === "baseUrl") {
        return {...state, fieldFocus: "model"};
      }
      return state;
    }
    case "begin-llm-verify":
      return {
        ...state,
        busy: true,
        llmVerification: "verifying",
        llmError: null,
        error: null,
      };
    case "llm-verify-success":
      return {
        ...state,
        busy: false,
        llmVerification: "verified",
        llmVerificationId: action.verificationId,
        llmError: null,
      };
    case "llm-verify-failed":
      return {
        ...state,
        busy: false,
        llmVerification: "failed",
        llmError: action.message,
        error: action.message,
      };
    case "continue-to-search":
      if (state.llmVerification !== "verified" || !state.llmVerificationId) {
        return {
          ...state,
          error: "Verify the LLM connection before continuing.",
        };
      }
      return {...state, step: "search", error: null};
    case "back":
      if (state.step === "llm") {
        return {...state, step: "provider", error: null};
      }
      if (state.step === "search") {
        return {...state, step: "llm", error: null};
      }
      if (state.step === "review") {
        return {...state, step: "search", error: null};
      }
      return state;
    case "select-search-index":
      return {...state, selectedSearchIndex: action.index, error: null};
    case "set-search-key":
      return {
        ...state,
        searchKeys: {...state.searchKeys, [action.source]: action.value},
        searchVerification: {
          ...state.searchVerification,
          [action.source]: {state: "idle", id: null},
        },
        error: null,
      };
    case "begin-search-verify":
      return {
        ...state,
        busy: true,
        searchVerification: {
          ...state.searchVerification,
          [action.source]: {state: "verifying", id: null},
        },
        error: null,
      };
    case "search-verify-success":
      return {
        ...state,
        busy: false,
        enabledSearch: state.enabledSearch.includes(action.source)
          ? state.enabledSearch
          : [...state.enabledSearch, action.source],
        searchVerification: {
          ...state.searchVerification,
          [action.source]: {state: "verified", id: action.verificationId},
        },
      };
    case "search-verify-failed":
      return {
        ...state,
        busy: false,
        searchVerification: {
          ...state.searchVerification,
          [action.source]: {state: "failed", id: null, error: action.message},
        },
        error: action.message,
      };
    case "toggle-search-enabled": {
      const enabled = state.enabledSearch.includes(action.source);
      return {
        ...state,
        enabledSearch: enabled
          ? state.enabledSearch.filter((item) => item !== action.source)
          : [...state.enabledSearch, action.source],
      };
    }
    case "skip-search":
      if (state.llmVerification !== "verified") {
        return {...state, error: "Verify the LLM connection before continuing."};
      }
      return {...state, step: "review", error: null};
    case "begin-apply":
      return {...state, step: "saving", busy: true, error: null};
    case "apply-success":
      return {
        ...initialSetupState(action.status),
        step: "done",
        busy: false,
        status: action.status,
      };
    case "apply-failed":
      return {...state, step: "review", busy: false, error: action.message};
    case "set-error":
      return {...state, error: action.message};
    case "clear-error":
      return {...state, error: null};
    default:
      return state;
  }
}

export function maskSecret(value: string): string {
  if (!value) {
    return "";
  }
  return "*".repeat(Math.min(value.length, 24));
}

export function setupSummaryLines(state: SetupWizardState): string[] {
  const lines = [
    `Planner: ${state.provider}/${state.model}`,
    `API key: ${state.useStoredKey || state.llmVerification === "verified" ? "configured" : "not configured"}`,
  ];
  for (const source of KEYED_SEARCH) {
    const enabled = state.enabledSearch.includes(source);
    lines.push(`Search ${source}: ${enabled ? "enabled" : "disabled"}`);
  }
  return lines;
}

export function verifiedLlmState(status: SetupStatusResponse): SetupWizardState {
  return {
    ...initialSetupState(status),
    step: "search",
    llmVerification: "verified",
    llmVerificationId: "test-verification",
    apiKey: "configured",
    useStoredKey: true,
  };
}
