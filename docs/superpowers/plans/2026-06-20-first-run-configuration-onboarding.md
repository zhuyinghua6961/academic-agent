# First-Run Configuration Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require users to configure and verify a real LLM provider through an in-TUI first-run wizard, while storing reusable API keys globally and making search APIs optional.

**Architecture:** Add a setup domain service in the Python Core that owns status detection, live verification, short-lived verification sessions, and atomic persistence. Expose setup-safe FastAPI endpoints and guard all model-dependent endpoints against unconfigured use. Add a focused Ink wizard and pure TypeScript reducer so the existing TUI only coordinates startup and transitions.

**Tech Stack:** Python 3.12, FastAPI, Pydantic, httpx, tomlkit, python-dotenv, pytest; TypeScript, React, Ink, tsx, Node test runner; pnpm and generated JSON Schema/TypeScript types.

---

## File Map

- Create `services/core/src/academic_agent_core/setup.py`: setup state, verification sessions, safe validation, and atomic config/env persistence.
- Create `services/core/tests/test_setup.py`: focused setup, security, persistence, and API tests.
- Modify `services/core/src/academic_agent_core/config.py`: optional planner profile, global env precedence, and no implicit mock runtime fallback.
- Modify `services/core/src/academic_agent_core/providers.py`: minimal provider connection verification helpers.
- Modify `services/core/src/academic_agent_core/search.py`: keyed search-provider verification helper.
- Modify `services/core/src/academic_agent_core/schemas.py`: setup request/response contracts and structured configuration errors.
- Modify `services/core/src/academic_agent_core/api.py`: setup endpoints, manager lifecycle, and configuration guards.
- Modify `services/core/src/academic_agent_core/graph.py`: fail explicitly when a planner is unavailable.
- Modify `requirements.txt`: add `tomlkit` for comment-preserving TOML updates.
- Create `apps/tui/src/setup-state.ts`: pure wizard state and reducer.
- Create `apps/tui/src/setup-state.test.ts`: reducer/navigation tests.
- Create `apps/tui/src/setup-wizard.tsx`: masked input, provider/search steps, verification calls, and summary UI.
- Create `apps/tui/src/api-client.ts`: shared JSON HTTP helpers extracted from `index.tsx`.
- Modify `apps/tui/src/index.tsx`: setup-aware startup, `/config`, and `configuration_required` recovery.
- Modify `apps/tui/package.json`, `Makefile`: include TUI setup tests in `make test`.
- Regenerate `packages/schemas/src/generated/schema.json` and `packages/schemas/src/generated/types.ts`.
- Modify `README.md` and `.academic-agent/.env.example`: document onboarding, global credentials, and explicit mock development mode.

### Task 1: Represent Unconfigured State Without Mock Fallback

**Files:**
- Create: `services/core/tests/test_setup.py`
- Modify: `services/core/src/academic_agent_core/config.py:19-249`
- Modify: `services/core/src/academic_agent_core/config.py:252-366`

- [ ] **Step 1: Write failing configuration-state tests**

```python
def test_empty_project_has_no_planner_and_requires_setup(tmp_path: Path) -> None:
    ProjectWorkspace(tmp_path).init()
    config = AgentConfig.load(tmp_path, env={"HOME": str(tmp_path / "home")})

    assert config.planner_or_none() is None
    assert config.setup_state() == "unconfigured"


def test_legacy_mock_config_requires_setup(tmp_path: Path) -> None:
    write_config(tmp_path, '[providers.planner]\nprovider="mock"\nmodel="mock-idea-diagnoser-v0"\n')
    config = AgentConfig.load(tmp_path, env={"HOME": str(tmp_path / "home")})
    assert config.setup_state() == "unconfigured"


def test_explicit_development_override_allows_mock(tmp_path: Path) -> None:
    config = AgentConfig.load(
        tmp_path,
        env={"HOME": str(tmp_path / "home"), "ACADEMIC_AGENT_ALLOW_MOCK": "1"},
    )
    assert config.profile("planner").provider == "mock"
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
conda run -n academic-agent env PYTHONNOUSERSITE=1 \
  python -m pytest services/core/tests/test_setup.py -k "empty_project or legacy_mock or development_override" -v
```

Expected: FAIL because `planner_or_none` and `setup_state` do not exist and default config still emits mock.

- [ ] **Step 3: Implement optional planner configuration**

In `config.py`, add:

```python
class ConfigurationRequiredError(RuntimeError):
    code = "configuration_required"


def mock_provider_allowed(env: Mapping[str, str]) -> bool:
    return env.get("ACADEMIC_AGENT_ALLOW_MOCK", "").lower() in {"1", "true", "yes", "on"}
```

Build only profiles present in TOML/env. Keep non-planner test profiles out until configured. `profile(name)` raises `ConfigurationRequiredError` when missing; `planner_or_none()` returns `None`. Treat legacy mock as absent unless `ACADEMIC_AGENT_ALLOW_MOCK=1`.

Remove `[providers.planner] provider="mock"` from `render_default_project_config()` and update its header to state that onboarding supplies provider configuration.

- [ ] **Step 4: Add global credential precedence tests**

```python
def test_env_precedence_is_process_then_project_then_global(tmp_path: Path) -> None:
    home = tmp_path / "home"
    write_env(home / ".academic-agent/.env", "OPENAI_API_KEY=global\n")
    write_env(tmp_path / ".academic-agent/.env", "OPENAI_API_KEY=project\n")

    loaded = AgentConfig.load(tmp_path, env={"HOME": str(home)}).env
    assert loaded["OPENAI_API_KEY"] == "project"

    loaded = AgentConfig.load(
        tmp_path,
        env={"HOME": str(home), "OPENAI_API_KEY": "process"},
    ).env
    assert loaded["OPENAI_API_KEY"] == "process"
```

- [ ] **Step 5: Implement global env loading**

Load layers in this order, with later layers overriding earlier ones:

```text
~/.academic-agent/.env
<project>/.env
<project>/.academic-agent/.env
process environment
```

Do not mutate `os.environ`.

- [ ] **Step 6: Run focused tests and existing config tests**

Run:

```bash
conda run -n academic-agent env PYTHONNOUSERSITE=1 \
  python -m pytest services/core/tests/test_setup.py services/core/tests/test_foundation_slice.py \
  -k "config or provider_config_defaults" -v
```

Expected: PASS. Update legacy foundation tests to opt into `ACADEMIC_AGENT_ALLOW_MOCK=1` explicitly rather than relying on defaults.

- [ ] **Step 7: Commit**

```bash
git add services/core/src/academic_agent_core/config.py services/core/tests/test_setup.py services/core/tests/test_foundation_slice.py
git commit -m "feat: represent unconfigured provider state"
```

### Task 2: Add Setup Schemas And Status Endpoint

**Files:**
- Modify: `services/core/src/academic_agent_core/schemas.py:400-640`
- Create: `services/core/src/academic_agent_core/setup.py`
- Modify: `services/core/src/academic_agent_core/api.py:54-110`
- Test: `services/core/tests/test_setup.py`
- Regenerate: `packages/schemas/src/generated/schema.json`
- Regenerate: `packages/schemas/src/generated/types.ts`

- [ ] **Step 1: Write failing setup-status API tests**

```python
@pytest.mark.asyncio
async def test_setup_status_reports_unconfigured_without_secret_values(tmp_path: Path) -> None:
    app = create_app(tmp_path)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/projects/init", json={})
        response = await client.get("/setup/status")

    assert response.status_code == 200
    assert response.json()["state"] == "unconfigured"
    assert response.json()["setup_required"] is True
    assert "api_key" not in response.text.lower()
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
conda run -n academic-agent env PYTHONNOUSERSITE=1 \
  python -m pytest services/core/tests/test_setup.py::test_setup_status_reports_unconfigured_without_secret_values -v
```

Expected: FAIL with 404 for `/setup/status`.

- [ ] **Step 3: Define setup contracts**

Add Pydantic models with `extra="forbid"` inherited from `StrictModel`:

```python
SetupState = Literal["unconfigured", "invalid", "configured"]
SetupProviderName = Literal["openai", "anthropic", "deepseek", "openai_compatible"]

class SetupLlmCandidate(StrictModel):
    provider: SetupProviderName
    model: str = Field(min_length=1)
    base_url: str | None = None
    api_key_env: str = Field(min_length=1)

class SetupStatusResponse(StrictModel):
    state: SetupState
    setup_required: bool
    planner: SetupLlmCandidate | None = None
    has_api_key: bool = False
    provider_options: list[SetupProviderOption]
    search: list[SetupSearchStatus]
```

Also add `SetupVerifyRequest`, `SetupVerifyResponse`, `SetupSearchVerifyRequest`, `SetupApplyRequest`, and `SetupApplyResponse`. Secret request fields must use `repr=False`; response models must contain only booleans and safe metadata.

- [ ] **Step 4: Implement read-only `SetupManager.status()`**

`setup.py` owns provider option defaults and search status projection. It receives `project_root` and an env mapping, reads `AgentConfig`, and returns only safe fields.

- [ ] **Step 5: Register `GET /setup/status` and capability**

Create one `SetupManager` in `app.state`. Add `configuration_onboarding` to `CORE_CAPABILITIES`. The status endpoint must work before planner configuration.

- [ ] **Step 6: Generate shared schemas and run checks**

Run:

```bash
make schema
pnpm --filter @academic-agent/schemas typecheck
conda run -n academic-agent env PYTHONNOUSERSITE=1 \
  python -m pytest services/core/tests/test_setup.py -k setup_status -v
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add services/core/src/academic_agent_core/{schemas.py,setup.py,api.py} \
  services/core/tests/test_setup.py packages/schemas/src/generated
git commit -m "feat: expose configuration setup status"
```

### Task 3: Verify LLM And Search Credentials Safely

**Files:**
- Modify: `services/core/src/academic_agent_core/setup.py`
- Modify: `services/core/src/academic_agent_core/providers.py:42-880`
- Modify: `services/core/src/academic_agent_core/search.py`
- Modify: `services/core/src/academic_agent_core/api.py`
- Test: `services/core/tests/test_setup.py`

- [ ] **Step 1: Write failing verification-session tests**

Use injected verifier callables so unit tests never reach the network:

```python
def test_llm_verify_returns_single_use_token_without_echoing_secret(tmp_path: Path) -> None:
    manager = SetupManager(tmp_path, llm_verifier=lambda candidate, key: None)
    result = manager.verify_llm(candidate(), api_key="sk-test-secret")

    assert result.verified is True
    assert result.verification_id
    assert "sk-test-secret" not in result.model_dump_json()
    assert "sk-test-secret" not in repr(manager.verifications)


def test_verification_expires_and_is_bound_to_candidate(tmp_path: Path) -> None:
    # Inject a clock, advance past TTL, and assert apply rejects the id.
```

- [ ] **Step 2: Run tests and verify RED**

Expected: FAIL because verification sessions do not exist.

- [ ] **Step 3: Implement in-memory verification sessions**

Store:

```python
@dataclass
class VerificationSession:
    verification_id: str
    kind: Literal["llm", "search"]
    candidate_hash: str
    secret_fingerprint: str
    expires_at: float
```

Use `secrets.token_urlsafe`, `hashlib.sha256`, a five-minute TTL, injected clock/verifiers for tests, and constant-time comparison. Never store plaintext secrets.

- [ ] **Step 4: Add minimal provider verification functions**

Extend each live provider implementation with `verify_connection()` using its existing auth headers, base URL, and request helpers. Send the smallest valid request asking for `OK`, cap output tokens, use a short timeout, and disable provider caching. Normalize exceptions into:

```python
Literal["authentication_failed", "model_unavailable", "rate_limited", "network_failed", "timeout", "provider_error"]
```

Never include response bodies that may echo credentials.

- [ ] **Step 5: Add keyed search verification**

Reuse existing search source request/parsing paths with `max_results=1` and a fixed neutral query. Verify only Brave, Tavily, Serper, and SerpAPI; keyless sources return `not_required` without network access.

- [ ] **Step 6: Add fake-server integration tests**

Cover 200, 401, 404/model error, 429, malformed response, and timeout. Assert a sentinel key is absent from `response.text`, captured logs, workspace events, traces, and cache records.

- [ ] **Step 7: Register verify endpoints and run tests**

Run:

```bash
make schema
conda run -n academic-agent env PYTHONNOUSERSITE=1 \
  python -m pytest services/core/tests/test_setup.py -k verify -v
```

Expected: PASS with no external network calls.

- [ ] **Step 8: Commit**

```bash
git add services/core/src/academic_agent_core/{setup.py,providers.py,search.py,api.py,schemas.py} \
  services/core/tests/test_setup.py packages/schemas/src/generated
git commit -m "feat: verify setup credentials safely"
```

### Task 4: Persist Verified Configuration Atomically

**Files:**
- Modify: `requirements.txt`
- Modify: `services/core/src/academic_agent_core/setup.py`
- Modify: `services/core/src/academic_agent_core/api.py`
- Test: `services/core/tests/test_setup.py`

- [ ] **Step 1: Add `tomlkit` and install dependencies**

```text
tomlkit
```

Run: `make install`

- [ ] **Step 2: Write failing persistence tests**

```python
def test_apply_preserves_comments_and_writes_global_key_mode_0600(tmp_path: Path) -> None:
    home = tmp_path / "home"
    project_config = seed_config_with_runtime_comment(tmp_path)
    manager = verified_manager(tmp_path, home)

    manager.apply(valid_apply_request(api_key="sk-secret"))

    text = project_config.read_text()
    assert "# keep this comment" in text
    assert 'provider = "openai"' in text
    assert (home / ".academic-agent/.env").stat().st_mode & 0o777 == 0o600
    assert "sk-secret" not in text


def test_apply_rolls_back_when_second_replace_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Fail the second atomic replace and assert both original files remain byte-identical.
```

- [ ] **Step 3: Run tests and verify RED**

Expected: FAIL because apply/persistence is not implemented.

- [ ] **Step 4: Implement comment-preserving project config updates**

Use `tomlkit` to update only:

```toml
[providers.planner]
provider = "..."
model = "..."
api_key_env = "..."
base_url = "..."

[search]
paper_sources = ["arxiv", "openalex"]
web_sources = ["duckduckgo", ...verified keyed sources]
```

Preserve runtime, context, memory, unrelated providers, ordering, and comments.

- [ ] **Step 5: Implement global env updates and transaction-like rollback**

Patch only keys managed by the submitted provider/search selection. Preserve unrelated env lines. Write temporary files in the destination directory, `fsync`, chmod global env to `0600`, then `os.replace`. Keep byte backups until both replaces succeed; restore on failure.

Support `use_stored_key=True` by resolving the global key server-side and matching it to the verification fingerprint.

- [ ] **Step 6: Consume verification ids and reload status**

Apply must reject expired, mismatched, reused, or unverified ids with safe 409 responses. On success, consume ids, reload `AgentConfig`, and return `state="configured"` with safe statuses.

- [ ] **Step 7: Register `POST /setup/apply` and run tests**

Run:

```bash
conda run -n academic-agent env PYTHONNOUSERSITE=1 \
  python -m pytest services/core/tests/test_setup.py -k "apply or persistence or rollback" -v
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add requirements.txt services/core/src/academic_agent_core/{setup.py,api.py} services/core/tests/test_setup.py
git commit -m "feat: persist verified setup configuration"
```

### Task 5: Guard Runtime Endpoints And Migrate Mock Tests

**Files:**
- Modify: `services/core/src/academic_agent_core/api.py:106-410`
- Modify: `services/core/src/academic_agent_core/graph.py:89-118`
- Modify: `services/core/tests/test_foundation_slice.py`
- Test: `services/core/tests/test_setup.py`

- [ ] **Step 1: Write failing guard tests**

```python
@pytest.mark.asyncio
async def test_unconfigured_project_rejects_idea_plan_run(tmp_path: Path) -> None:
    app = create_app(tmp_path)
    async with api_client(app) as client:
        await client.post("/projects/init", json={})
        response = await client.post("/runs/idea-plan", json={"idea": "test"})

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "configuration_required"


def test_runner_does_not_construct_mock_when_unconfigured(tmp_path: Path) -> None:
    with pytest.raises(ConfigurationRequiredError):
        IdeaPlanRunner(ProjectWorkspace(tmp_path))
```

- [ ] **Step 2: Run tests and verify RED**

Expected: existing API starts a mock run.

- [ ] **Step 3: Add a single configuration guard**

Create an API helper that maps `ConfigurationRequiredError` to:

```json
{"detail":{"code":"configuration_required","message":"Complete provider setup before starting a run."}}
```

Use it for run creation/continuation and model-dependent context endpoints. Keep `/capabilities`, `/projects/init`, `/projects/status`, `/setup/*`, and thread/artifact reads setup-safe.

- [ ] **Step 4: Make `IdeaPlanRunner` require a configured planner**

Call `config.profile("planner")` and allow `ConfigurationRequiredError` to propagate before provider/tool construction.

- [ ] **Step 5: Migrate tests to explicit mock mode**

Add a focused fixture/helper that writes explicit mock config and sets `ACADEMIC_AGENT_ALLOW_MOCK=1`. Apply it only to tests that exercise deterministic mock runs. Setup tests must never inherit the override.

- [ ] **Step 6: Run core tests**

Run:

```bash
make test-python
```

Expected: all Python tests PASS; no test depends on silent mock fallback.

- [ ] **Step 7: Commit**

```bash
git add services/core/src/academic_agent_core/{api.py,graph.py} \
  services/core/tests/{test_setup.py,test_foundation_slice.py}
git commit -m "feat: block runs until provider setup completes"
```

### Task 6: Build A Pure TUI Setup State Machine

**Files:**
- Create: `apps/tui/src/setup-state.ts`
- Create: `apps/tui/src/setup-state.test.ts`
- Modify: `apps/tui/package.json`
- Modify: `Makefile`

- [ ] **Step 1: Write failing reducer tests**

```typescript
test("requires verified LLM before search step", () => {
  let state = initialSetupState(statusFixture);
  state = setupReducer(state, {type: "select-provider", provider: "openai"});
  state = setupReducer(state, {type: "submit-llm"});
  assert.equal(state.step, "llm");
  assert.equal(state.error, "Verify the LLM connection before continuing.");
});

test("can skip optional search and reach review", () => {
  const state = setupReducer(verifiedLlmState(), {type: "skip-search"});
  assert.equal(state.step, "review");
});
```

- [ ] **Step 2: Add the test command and verify RED**

In `apps/tui/package.json`:

```json
"test": "node --import tsx --test src/setup-state.test.ts"
```

Run: `pnpm --filter @academic-agent/tui test`

Expected: FAIL because `setup-state.ts` does not exist.

- [ ] **Step 3: Implement reducer and typed payload builders**

Model steps as:

```typescript
type SetupStep = "provider" | "llm" | "search" | "review" | "saving" | "done";
type VerificationState = "idle" | "verifying" | "verified" | "failed";
```

Keep plaintext keys only in reducer state, never in transcript-shaped types. Any provider/model/Base URL edit clears the LLM verification id. Any search key/source edit clears that source's verification id.

- [ ] **Step 4: Add masking and existing-key tests**

Cover backspace, paste/input append, `use_stored_key`, Esc step reversal, verification retry, and summary output that includes only `configured/not configured`.

- [ ] **Step 5: Add TUI tests to `make test`**

Add `test-tui` and make `test` depend on `schema test-python test-tui typecheck`.

- [ ] **Step 6: Run tests and commit**

```bash
pnpm --filter @academic-agent/tui test
make typecheck
git add apps/tui/src/setup-state.ts apps/tui/src/setup-state.test.ts apps/tui/package.json Makefile
git commit -m "feat: add setup wizard state machine"
```

### Task 7: Implement And Integrate The Ink Setup Wizard

**Files:**
- Create: `apps/tui/src/api-client.ts`
- Create: `apps/tui/src/setup-wizard.tsx`
- Modify: `apps/tui/src/index.tsx:1-60`
- Modify: `apps/tui/src/index.tsx:500-620`
- Modify: `apps/tui/src/index.tsx:1143-1427`
- Modify: `apps/tui/src/index.tsx:1560-1660`
- Test: `apps/tui/src/setup-state.test.ts`

- [ ] **Step 1: Extract JSON client helpers without behavior changes**

Move `getJson` and `postJson` into `api-client.ts`; keep error text and abort behavior unchanged. Run `make typecheck`.

- [ ] **Step 2: Implement `SetupWizard` rendering and input**

The component owns its setup reducer and uses `useInput({isActive})`. Render stable-width rows with a selected marker, masked keys (`*` only), verification status, and review summary. Props:

```typescript
type SetupWizardProps = {
  coreUrl: string;
  initialStatus: SetupStatusResponse;
  onComplete: (status: SetupStatusResponse) => void;
  onCancel?: () => void;
};
```

Do not add setup inputs or secret-bearing errors to the transcript.

- [ ] **Step 3: Connect verify/apply calls**

Use generated schemas for payloads. Disable input while requests are in flight. Convert safe backend error categories into concise user-facing text. After apply, refetch `/setup/status` and call `onComplete` only when `state="configured"`.

- [ ] **Step 4: Add setup-aware application startup**

Extend `UiState` with `setup-loading` and `setup`. On mount:

```text
POST /projects/init
GET /setup/status
configured -> load normal startup/resume/idea behavior
otherwise -> render SetupWizard
```

Gate context/session effects until setup is configured. Delay `--idea`, `--resume`, and resume-list handling until setup completes.

- [ ] **Step 5: Add `/config` and 409 recovery**

Add `config` to slash commands and help. `/config` fetches status and opens the wizard with non-sensitive fields prefilled. If any normal API call returns `configuration_required`, clear pending run UI and reopen setup instead of writing an error transcript entry.

- [ ] **Step 6: Make provider status unambiguous**

Replace `mock-safe` fallback text. Configured header must show `live`; setup mode must show `Configuration required`. User-facing runtime must never display a mock planner unless `ACADEMIC_AGENT_ALLOW_MOCK=1` is explicitly set.

- [ ] **Step 7: Run TUI tests and typecheck**

```bash
pnpm --filter @academic-agent/tui test
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/tui/src/{api-client.ts,setup-state.ts,setup-state.test.ts,setup-wizard.tsx,index.tsx} \
  apps/tui/package.json
git commit -m "feat: guide first-run provider configuration"
```

### Task 8: Add End-To-End Setup Coverage And Documentation

**Files:**
- Create: `services/core/tests/test_setup_cli_smoke.py`
- Modify: `README.md`
- Modify: `.academic-agent/.env.example`
- Modify: `services/core/tests/test_setup.py`

- [ ] **Step 1: Add PTY first-render smoke test**

Use Python `pty`, a temporary HOME/project, and a test Core process. Start the TUI in an empty project and assert ANSI-stripped output contains `Configure Academic Agent` and does not contain `Research idea:`. Terminate cleanly after the assertion.

- [ ] **Step 2: Add configured-project bypass smoke test**

Seed a verified test configuration with explicit mock development override, start the same TUI, and assert output contains `Research idea:` without rendering setup.

- [ ] **Step 3: Test secret redaction end to end**

Submit `sk-sentinel-never-log` through fake verification/apply. Recursively inspect temp project files except the expected global env file and assert the sentinel is absent from SQLite, logs, traces, cache, artifacts, API responses, and captured TUI output.

- [ ] **Step 4: Update documentation**

Document:

- first-run flow and `/config`;
- global `~/.academic-agent/.env` credential reuse;
- project-local non-sensitive config;
- optional search providers;
- explicit `ACADEMIC_AGENT_ALLOW_MOCK=1` for development only;
- troubleshooting verification categories without exposing keys.

- [ ] **Step 5: Run full verification**

```bash
make test
conda run -n academic-agent env PYTHONNOUSERSITE=1 \
  python -m ruff check services/core/src services/core/tests
conda run -n academic-agent env PYTHONNOUSERSITE=1 \
  python -m mypy services/core/src/academic_agent_core
```

Expected: all commands exit 0 with 0 failures/errors.

- [ ] **Step 6: Manual empty-directory smoke test**

```bash
tmpdir="$(mktemp -d)"
cd "$tmpdir"
academic-agent
```

Verify setup appears before research input, key input is masked, failed validation does not write files, successful validation enters Idea Plan, and a second launch skips setup.

- [ ] **Step 7: Commit**

```bash
git add services/core/tests/test_setup_cli_smoke.py services/core/tests/test_setup.py \
  README.md .academic-agent/.env.example
git commit -m "test: cover first-run configuration workflow"
```

### Task 9: Final Review And Delivery

**Files:**
- Review all files listed in the File Map.

- [ ] **Step 1: Inspect the complete diff**

```bash
git diff --check
git status --short
git diff --stat
```

Confirm generated schemas match `schemas.py`, secrets are absent, and unrelated worktree changes are not staged.

- [ ] **Step 2: Re-run verification from a clean process**

```bash
make test
```

Expected: Python, TUI reducer tests, schema generation, and TypeScript typecheck all PASS.

- [ ] **Step 3: Review security invariants**

Search for secret-bearing setup fields and ensure none flow into logging/events/traces/cache:

```bash
rg -n "api_key|verification_id|Setup.*Request" services/core/src apps/tui/src
```

Review each match manually; request parsing and global env persistence are the only plaintext-secret boundaries.

- [ ] **Step 4: Prepare final commit if any review-only fixes remain**

```bash
git add <reviewed-files-only>
git commit -m "fix: harden setup onboarding"
```

- [ ] **Step 5: Summarize delivery**

Report setup behavior, storage locations, verification evidence, migration behavior, and any provider-specific limitations. Do not report success until fresh verification output is available.
