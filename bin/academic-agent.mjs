#!/usr/bin/env node
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {resolve, dirname} from "node:path";
import {resolveProjectRoot} from "./academic-agent-runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolveProjectRoot({cwd: process.cwd(), env: process.env});
const args = process.argv.slice(2);

if (!args.includes("--help") && !args.includes("-h")) {
  process.stderr.write(`Academic Agent (TypeScript)\nProject root: ${projectRoot}\n`);
}

const child = spawn(
  "pnpm",
  ["--filter", "@academic-agent/app", "start", "--", ...args],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ACADEMIC_AGENT_PROJECT_ROOT: projectRoot,
    },
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
