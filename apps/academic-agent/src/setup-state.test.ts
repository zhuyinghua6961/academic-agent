import assert from "node:assert/strict";
import test from "node:test";

import {
  initialSetupState,
  setupReducer,
  verifiedLlmState,
  type SetupWizardState,
} from "./setup-state.js";
import type {SetupStatusResponse} from "@academic-agent/schemas";

const statusFixture = (): SetupStatusResponse => ({
  state: "unconfigured",
  setup_required: true,
  planner: null,
  has_api_key: false,
  provider_options: [
    {
      provider: "openai",
      label: "OpenAI",
      default_model: "gpt-4.1-mini",
      default_api_key_env: "OPENAI_API_KEY",
      default_base_url: "https://api.openai.com/v1",
      requires_base_url: false,
    },
    {
      provider: "anthropic",
      label: "Anthropic",
      default_model: "claude-3-5-haiku-latest",
      default_api_key_env: "ANTHROPIC_API_KEY",
      default_base_url: "https://api.anthropic.com",
      requires_base_url: false,
    },
  ],
  search: [],
});

test("requires verified LLM before search step", () => {
  let state = initialSetupState(statusFixture());
  state = setupReducer(state, {type: "select-provider-index", index: 0});
  state = setupReducer(state, {type: "confirm-provider"});
  state = setupReducer(state, {type: "continue-to-search"});
  assert.equal(state.step, "llm");
  assert.equal(state.error, "Verify the LLM connection before continuing.");
});

test("can skip optional search and reach review", () => {
  const state = setupReducer(verifiedLlmState(statusFixture()), {type: "skip-search"});
  assert.equal(state.step, "review");
});

test("editing provider fields clears LLM verification", () => {
  let state = verifiedLlmState(statusFixture());
  state = setupReducer(state, {type: "set-model", value: "gpt-4.1"});
  assert.equal(state.llmVerification, "idle");
  assert.equal(state.llmVerificationId, null);
});

test("reconfigure opens provider step even when already configured", () => {
  const status = statusFixture();
  const state = initialSetupState(
    {...status, state: "configured", setup_required: false, has_api_key: true, planner: {
      provider: "openai",
      model: "gpt-4.1-mini",
      api_key_env: "OPENAI_API_KEY",
      base_url: "https://api.openai.com/v1",
    }},
    {reconfigure: true},
  );
  assert.equal(state.step, "provider");
  assert.equal(state.llmVerification, "idle");
});
