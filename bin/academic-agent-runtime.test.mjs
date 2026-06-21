import assert from "node:assert/strict";
import test from "node:test";

import {configPaths, resolveProjectRoot} from "./academic-agent-runtime.mjs";

test("uses the caller cwd as the default project root", () => {
  assert.equal(
    resolveProjectRoot({
      cwd: "/tmp/user-project",
      env: {},
    }),
    "/tmp/user-project",
  );
});

test("allows ACADEMIC_AGENT_PROJECT_ROOT to override the caller cwd", () => {
  assert.equal(
    resolveProjectRoot({
      cwd: "/tmp/user-project",
      env: {ACADEMIC_AGENT_PROJECT_ROOT: "/tmp/explicit-project"},
    }),
    "/tmp/explicit-project",
  );
});

test("reads config from home and project root without leaking source repo config", () => {
  assert.deepEqual(
    configPaths({
      home: "/Users/example",
      projectRoot: "/tmp/user-project",
      repoRoot: "/Users/example/academic-agent",
      env: {},
    }),
    [
      "/Users/example/.academic-agent/config.toml",
      "/tmp/user-project/.academic-agent/config.toml",
    ],
  );
});
