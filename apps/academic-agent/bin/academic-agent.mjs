#!/usr/bin/env node
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {resolve, dirname} from "node:path";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

const child = spawn(
  "pnpm",
  ["exec", "tsx", resolve(appRoot, "src/index.tsx"), ...args],
  {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
