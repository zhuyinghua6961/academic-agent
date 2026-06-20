import assert from "node:assert/strict";
import test from "node:test";

import {configPaths, coreSpawnPlan, resolveProjectRoot} from "./academic-agent-runtime.mjs";

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

test("uses source repo for app code but project root for core cwd and logs", () => {
  const plan = coreSpawnPlan({
    repoRoot: "/Users/example/academic-agent",
    projectRoot: "/tmp/user-project",
    condaEnv: "academic-agent",
    host: "127.0.0.1",
    port: "8765",
  });

  assert.equal(plan.cwd, "/tmp/user-project");
  assert.equal(plan.logPath, "/tmp/user-project/.academic-agent/core-8765.log");
  assert.deepEqual(plan.args.slice(0, 5), ["run", "-n", "academic-agent", "env", "PYTHONNOUSERSITE=1"]);
  assert.ok(plan.args.includes("/Users/example/academic-agent/services/core/src"));
});
