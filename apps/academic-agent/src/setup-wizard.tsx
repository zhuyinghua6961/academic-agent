import React, {useCallback, useReducer} from "react";
import {Box, Text, useInput} from "ink";

import type {AcademicAgentClient} from "./client.js";
import {
  buildLlmCandidate,
  initialSetupState,
  maskSecret,
  setupReducer,
  setupSummaryLines,
  type SetupWizardState,
} from "./setup-state.js";
import type {SetupKeyedSearchSource, SetupStatusResponse} from "@academic-agent/schemas";

const KEYED_SEARCH: SetupKeyedSearchSource[] = ["brave", "tavily", "serper", "serpapi"];

const SEARCH_LABELS: Record<SetupKeyedSearchSource, string> = {
  brave: "Brave Search",
  tavily: "Tavily",
  serper: "Serper",
  serpapi: "SerpAPI",
};

type SetupWizardProps = {
  client: AcademicAgentClient;
  initialStatus: SetupStatusResponse;
  reconfigure?: boolean;
  onComplete: (status: SetupStatusResponse) => void;
  onDismiss?: () => void;
  onCancel?: () => void;
};

const Row = ({
  selected,
  children,
}: {
  selected: boolean;
  children: React.ReactNode;
}) => (
  <Text>
    {selected ? "› " : "  "}
    {children}
  </Text>
);

export const SetupWizard = ({
  client,
  initialStatus,
  reconfigure = false,
  onComplete,
  onDismiss,
  onCancel,
}: SetupWizardProps) => {
  const [state, dispatch] = useReducer(
    setupReducer,
    {status: initialStatus, reconfigure},
    ({status, reconfigure: mode}) => initialSetupState(status, {reconfigure: mode}),
  );

  const verifyLlm = useCallback(async () => {
    dispatch({type: "begin-llm-verify"});
    try {
      const response = await client.verifySetupLlm({
        candidate: buildLlmCandidate(state),
        api_key: state.useStoredKey ? undefined : state.apiKey,
        use_stored_key: state.useStoredKey,
      });
      if (!response.verified || !response.verification_id) {
        dispatch({
          type: "llm-verify-failed",
          message: response.message ?? "LLM verification failed",
        });
        return;
      }
      dispatch({type: "llm-verify-success", verificationId: response.verification_id});
    } catch (error) {
      dispatch({
        type: "llm-verify-failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [client, state]);

  const verifySearch = useCallback(
    async (source: SetupKeyedSearchSource) => {
      dispatch({type: "begin-search-verify", source});
      try {
        const response = await client.verifySetupSearch({
          source,
          api_key: state.searchKeys[source],
          use_stored_key: false,
        });
        if (!response.verified || !response.verification_id) {
          dispatch({
            type: "search-verify-failed",
            source,
            message: response.message ?? "Search verification failed",
          });
          return;
        }
        dispatch({
          type: "search-verify-success",
          source,
          verificationId: response.verification_id,
        });
      } catch (error) {
        dispatch({
          type: "search-verify-failed",
          source,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [client, state.searchKeys],
  );

  const applySetup = useCallback(async () => {
    if (!state.llmVerificationId) {
      dispatch({type: "set-error", message: "LLM verification is required"});
      return;
    }
    dispatch({type: "begin-apply"});
    try {
      const searchVerificationIds: Record<string, string> = {};
      const searchApiKeys: Record<string, string> = {};
      for (const source of state.enabledSearch) {
        const verification = state.searchVerification[source];
        if (verification?.id) {
          searchVerificationIds[source] = verification.id;
          const key = state.searchKeys[source];
          if (key) {
            searchApiKeys[source] = key;
          }
        }
      }
      const response = client.applySetup({
        llm_verification_id: state.llmVerificationId,
        candidate: buildLlmCandidate(state),
        api_key: state.useStoredKey ? undefined : state.apiKey,
        use_stored_key: state.useStoredKey,
        search_verification_ids: searchVerificationIds,
        search_api_keys: searchApiKeys,
        enabled_search_sources: ["arxiv", "openalex", "duckduckgo", ...state.enabledSearch],
      });
      dispatch({type: "apply-success", status: response});
      onComplete(response);
    } catch (error) {
      dispatch({
        type: "apply-failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [client, onComplete, state]);

  useInput((input, key) => {
    if (state.busy) {
      return;
    }
    if (key.ctrl && input === "c") {
      onCancel?.();
      return;
    }
    if (key.escape) {
      if (state.step === "provider" && reconfigure) {
        onDismiss?.();
        return;
      }
      dispatch({type: "back"});
      return;
    }

    if (state.step === "provider") {
      if (key.upArrow || input === "k") {
        dispatch({
          type: "select-provider-index",
          index: Math.max(0, state.selectedProviderIndex - 1),
        });
        return;
      }
      if (key.downArrow || input === "j") {
        dispatch({
          type: "select-provider-index",
          index: Math.min(state.status.provider_options.length - 1, state.selectedProviderIndex + 1),
        });
        return;
      }
      if (key.return) {
        dispatch({type: "confirm-provider"});
      }
      return;
    }

    if (state.step === "llm") {
      if (key.tab) {
        dispatch({type: "focus-next-field"});
        return;
      }
      if (key.shift && key.tab) {
        dispatch({type: "focus-prev-field"});
        return;
      }
      if (input === "s" && state.status.has_api_key) {
        dispatch({type: "toggle-use-stored-key"});
        return;
      }
      if (key.return) {
        if (state.llmVerification === "verified") {
          dispatch({type: "continue-to-search"});
          return;
        }
        void verifyLlm();
        return;
      }
      if (key.backspace || key.delete) {
        if (state.fieldFocus === "model") {
          dispatch({type: "set-model", value: state.model.slice(0, -1)});
        } else if (state.fieldFocus === "baseUrl") {
          dispatch({type: "set-base-url", value: state.baseUrl.slice(0, -1)});
        } else if (!state.useStoredKey) {
          dispatch({type: "set-api-key", value: state.apiKey.slice(0, -1)});
        }
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        if (state.fieldFocus === "model") {
          dispatch({type: "set-model", value: state.model + input});
        } else if (state.fieldFocus === "baseUrl") {
          dispatch({type: "set-base-url", value: state.baseUrl + input});
        } else if (!state.useStoredKey) {
          dispatch({type: "set-api-key", value: state.apiKey + input});
        }
      }
      return;
    }

    if (state.step === "search") {
      if (key.upArrow || input === "k") {
        dispatch({
          type: "select-search-index",
          index: Math.max(0, state.selectedSearchIndex - 1),
        });
        return;
      }
      if (key.downArrow || input === "j") {
        dispatch({
          type: "select-search-index",
          index: Math.min(KEYED_SEARCH.length - 1, state.selectedSearchIndex + 1),
        });
        return;
      }
      const source = KEYED_SEARCH[state.selectedSearchIndex]!;
      if (input === " ") {
        dispatch({type: "toggle-search-enabled", source});
        return;
      }
      if (input === "v") {
        void verifySearch(source);
        return;
      }
      if (key.return) {
        dispatch({type: "skip-search"});
        return;
      }
      if (key.backspace || key.delete) {
        const current = state.searchKeys[source] ?? "";
        dispatch({type: "set-search-key", source, value: current.slice(0, -1)});
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        dispatch({
          type: "set-search-key",
          source,
          value: `${state.searchKeys[source] ?? ""}${input}`,
        });
      }
      return;
    }

    if (state.step === "review" && key.return) {
      void applySetup();
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Configure Academic Agent
      </Text>
      <Text dimColor>First-run setup: verify a live planner provider before research runs.</Text>
      {reconfigure ? (
        <Text dimColor>Reconfiguring provider settings. Esc on the first step returns to your session.</Text>
      ) : null}
      {renderStep(state)}
      {state.error ? <Text color="red">{state.error}</Text> : null}
      <Text dimColor>Esc back · Enter continue/verify · Ctrl+C cancel</Text>
    </Box>
  );
};

function renderStep(state: SetupWizardState): React.ReactNode {
  if (state.step === "provider") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Select planner provider</Text>
        {state.status.provider_options.map((option, index) => (
          <Row key={option.provider} selected={index === state.selectedProviderIndex}>
            {option.label} ({option.default_model})
          </Row>
        ))}
      </Box>
    );
  }

  if (state.step === "llm") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Verify planner connection</Text>
        <Text>
          Provider: {state.provider} {state.fieldFocus === "model" ? "▸" : ""}
        </Text>
        <Text>
          Model: {state.model}
          {state.fieldFocus === "model" ? "█" : ""}
        </Text>
        <Text>
          Base URL: {state.baseUrl || "(default)"}
          {state.fieldFocus === "baseUrl" ? "█" : ""}
        </Text>
        <Text>
          API key env: {state.apiKeyEnv}
        </Text>
        <Text>
          API key:{" "}
          {state.useStoredKey
            ? "configured (stored)"
            : maskSecret(state.apiKey) + (state.fieldFocus === "apiKey" ? "█" : "")}
        </Text>
        {state.status.has_api_key ? <Text dimColor>Press s to use stored key</Text> : null}
        <Text>
          Verification: {state.llmVerification}
          {state.llmVerification === "verified" ? " ✓" : ""}
        </Text>
        {state.llmError ? <Text color="yellow">{state.llmError}</Text> : null}
        <Text dimColor>Enter verify · Enter again to continue after success</Text>
      </Box>
    );
  }

  if (state.step === "search") {
    const source = KEYED_SEARCH[state.selectedSearchIndex]!;
    const verification = state.searchVerification[source];
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Optional search providers</Text>
        {KEYED_SEARCH.map((item, index) => (
          <Row key={item} selected={index === state.selectedSearchIndex}>
            {SEARCH_LABELS[item]} [{state.enabledSearch.includes(item) ? "x" : " "}]{" "}
            {verification?.state === "verified" ? "verified" : "not verified"}
          </Row>
        ))}
        <Text>
          API key: {maskSecret(state.searchKeys[source] ?? "")}
          {state.selectedSearchIndex >= 0 ? "█" : ""}
        </Text>
        <Text dimColor>Space toggle · v verify · Enter skip to review</Text>
      </Box>
    );
  }

  if (state.step === "review" || state.step === "saving") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Review configuration</Text>
        {setupSummaryLines(state).map((line) => (
          <Text key={line}>{line}</Text>
        ))}
        <Text>{state.step === "saving" ? "Saving..." : "Enter to save configuration"}</Text>
      </Box>
    );
  }

  return null;
}
