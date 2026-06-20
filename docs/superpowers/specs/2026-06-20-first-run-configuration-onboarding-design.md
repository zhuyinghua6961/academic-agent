# First-Run Configuration Onboarding Design

## Goal

Replace the silent mock-provider fallback with an explicit first-run setup flow. A user must configure and verify a real LLM provider before starting an Idea Plan run. Search APIs remain optional. Secrets are reusable across projects without being exposed through API responses, traces, logs, or TUI history.

## Configuration Ownership

Configuration has three explicit states:

- `unconfigured`: no usable planner provider has been selected.
- `invalid`: provider settings exist but required fields, credentials, or verification are missing.
- `configured`: the selected LLM provider has passed verification and can serve live requests.

The runtime must no longer synthesize `mock` when planner configuration is absent. `mock` remains available only through an explicit test/development override and is not shown in onboarding.

`AgentConfig` must allow the planner profile to be absent. Setup-safe endpoints, project initialization, capabilities, and health checks continue to work without a planner. Any endpoint that requires model metadata, including context estimation and Idea Plan execution, must either wait until setup completes or return `configuration_required` rather than constructing a mock profile.

Non-sensitive project choices are stored in `<project>/.academic-agent/config.toml`. API keys are stored globally in `~/.academic-agent/.env` and reused by all projects. Existing project-level `.env` support may remain for explicit overrides, but onboarding writes only to the global file.

The environment loader must read `~/.academic-agent/.env` before project-level env files. Existing process environment variables keep highest precedence; project env files may explicitly override global stored credentials only when the key is not already supplied by the process environment.

## Core API

The Core owns validation and persistence. The TUI never writes config files directly.

- `GET /setup/status`: returns configuration state, selected provider/model, required fields, safe credential-presence flags, search source status, and whether setup is required.
- `POST /setup/llm/verify`: accepts an in-memory provider candidate and optional API key, performs a minimal live request, and returns a safe verification result.
- `POST /setup/search/verify`: verifies one optional keyed search provider.
- `POST /setup/apply`: persists only previously verified settings and reloads runtime configuration.

A successful verification returns an opaque, short-lived `verification_id`. The Core stores only the normalized candidate and a one-way fingerprint of the submitted or already stored secret in an in-memory verification session. For a new credential, apply resubmits the candidate and secret, proves they match the verification session, then consumes the id. For an existing credential, the client sends `use_stored_key: true`; verify and apply both resolve the global key server-side without exposing it to the TUI. Verification ids expire after a short TTL, are single-use, and are invalidated when provider, model, Base URL, or credential changes. This prevents an unverified payload from being substituted between verify and apply without persisting secrets before confirmation.

Idea Plan run endpoints return structured `409 configuration_required` responses while setup is incomplete. They must never fall back to mock.

## TUI Flow

Startup initializes the project and requests setup status before accepting research input. An unconfigured or invalid project enters a dedicated `setup` UI state.

While setup is active, the TUI must not request context usage, thread plans, or start/resume runs. It may call only project initialization, capabilities, setup status, verification, and apply endpoints. After apply, it reloads provider and search statuses before enabling normal effects.

1. Select `OpenAI`, `Anthropic`, `DeepSeek`, or `OpenAI-compatible`.
2. Accept or edit the default model. OpenAI-compatible also requires a Base URL.
3. Enter a masked API key and verify the LLM connection. Successful verification is required to continue.
4. Configure optional search APIs for Brave, Tavily, Serper, and SerpAPI. Each can be verified or skipped. arXiv, OpenAlex, and DuckDuckGo remain available without keys.
5. Review safe configuration details and save. The summary shows credential presence, never credential values.

Arrow keys navigate choices, Enter selects or submits, Esc returns to the previous step, and Ctrl+C exits. `/config` reopens onboarding for an existing project. Existing non-sensitive values are prefilled; stored keys are represented only as `configured`.

## Persistence And Security

API keys exist in request memory only until apply and are excluded from structured logging, events, traces, provider cache keys, exceptions, and response bodies. Existing stored keys may be used for verification without being returned to the client.

Verification requests and responses must be excluded from the normal provider response cache. The opaque verification session stores no plaintext key; the request-scoped plaintext is compared by fingerprint during apply and discarded immediately after use.

The global env file is created with mode `0600`. Project TOML updates use a structured writer and preserve unrelated runtime, context, memory, and user-comment content. Both files are staged through temporary files and atomically replaced. Apply keeps backups long enough to roll back if either write fails, preventing a partially configured state.

LLM verification uses a minimal request and a short timeout. Errors are normalized to safe categories such as authentication failure, unavailable model, rate limit, network failure, or timeout. Search verification failures do not block setup; failed sources remain disabled.

Legacy auto-generated `provider = "mock"` configurations are treated as unconfigured. Test code must opt into mock explicitly.

## Data Flow

```text
TUI startup
-> Core project initialization
-> GET /setup/status
-> setup wizard when required
-> verify LLM and optional search candidates
-> POST /setup/apply
-> atomic global env + project TOML writes
-> reload and re-check setup status
-> normal Idea Plan input
```

## Testing

- Unit-test `unconfigured`, `invalid`, and `configured` detection, including legacy mock migration.
- Verify secrets never appear in API responses, events, traces, caches, or errors, and that the global env file uses `0600` permissions.
- Test structured TOML preservation, env updates, atomic writes, and rollback.
- Use local fake HTTP servers for LLM/search verification success, authentication errors, missing models, rate limits, and timeouts.
- Add API integration coverage proving unconfigured runs return 409 and verified setup enables live-ready provider status.
- Extract the TUI wizard reducer/state machine and test navigation, retries, optional search skipping, and reconfiguration.
- Add PTY smoke tests for first launch in an empty directory and direct launch in a configured directory.
- Include setup tests in `make test` alongside Python tests and TypeScript typechecking.

## Out Of Scope

- OS keychain integration.
- Automatic provider account creation or billing setup.
- Persisting API keys per project through onboarding.
- Downloading model catalogs dynamically from providers.
- Supporting mock as a user-facing runtime provider.
