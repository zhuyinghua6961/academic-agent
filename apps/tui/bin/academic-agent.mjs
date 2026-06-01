#!/usr/bin/env node
import {spawn} from "node:child_process";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const entry = fileURLToPath(new URL("../src/index.tsx", import.meta.url));

const child = spawn(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
