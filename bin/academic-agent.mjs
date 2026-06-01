#!/usr/bin/env node
import {spawn} from "node:child_process";
import {existsSync, mkdirSync, openSync, readFileSync} from "node:fs";
import {basename, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const runtimeConfig = readRuntimeConfig();
const coreUrl = coreUrlFromArgs(args, runtimeConfig);
const requiredCoreCapabilities = ["run_cancel"];
const helpRequested = args.includes("--help") || args.includes("-h");
const explicitCoreUrl = hasArg(args, "--core-url") || Boolean(process.env.ACADEMIC_AGENT_CORE_URL);

let managedCore = null;
let shuttingDown = false;

if (!helpRequested) {
  managedCore = await ensureLocalCore(coreUrl, {requireManagedPort: !explicitCoreUrl});
}

const child = spawnPnpm(
  ["--filter", "@academic-agent/tui", "start", "--", ...argsWithCoreUrl(args, coreUrl)],
  {
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  void finish(code ?? 0, signal);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
    void finish(signal === "SIGINT" ? 130 : 143, null);
  });
}

async function finish(code, signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await stopManagedCore();
  if (signal) {
    process.exit(signal === "SIGINT" ? 130 : 143);
    return;
  }
  process.exit(code);
}

function hasArg(argv, name) {
  return argv.includes(name);
}

function argsWithCoreUrl(argv, urlText) {
  if (hasArg(argv, "--core-url")) {
    return argv;
  }
  return [...argv, "--core-url", urlText];
}

function coreUrlFromArgs(argv, config) {
  const index = argv.indexOf("--core-url");
  if (index >= 0 && argv[index + 1]) {
    return argv[index + 1];
  }
  if (process.env.ACADEMIC_AGENT_CORE_URL) {
    return process.env.ACADEMIC_AGENT_CORE_URL;
  }
  if (config.coreUrl) {
    return config.coreUrl;
  }
  const host = config.coreHost || "127.0.0.1";
  const port = config.corePort || "8765";
  return `http://${host}:${port}`;
}

async function ensureLocalCore(urlText, {requireManagedPort}) {
  const url = new URL(urlText);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
    return null;
  }
  const port = url.port || "8765";

  const compatibility = await coreCompatibility(urlText);
  if (compatibility.ready && requireManagedPort) {
    process.stderr.write(`Releasing existing Academic Agent core on port ${port}...\n`);
    try {
      await releasePort(port);
    } catch (error) {
      process.stderr.write(
        `Could not inspect or release port ${port}: ${
          error instanceof Error ? error.message : String(error)
        }\n` + `Release it manually with: lsof -tiTCP:${port} -sTCP:LISTEN | xargs -r kill\n`,
      );
      process.exit(1);
    }
    const released = await waitForCoreDown(urlText, 3_000);
    if (!released) {
      process.stderr.write(
        `Could not release port ${port}. Stop the old process manually:\n` +
          `  lsof -tiTCP:${port} -sTCP:LISTEN | xargs -r kill\n`,
      );
      process.exit(1);
    }
  } else if (compatibility.compatible) {
    return null;
  } else if (compatibility.ready) {
    process.stderr.write(
      `Existing service at ${urlText} is not compatible with this TUI.\n` +
        `${compatibility.reason}\n` +
        "Release the port, then start again:\n" +
        `  lsof -tiTCP:${port} -sTCP:LISTEN | xargs -r kill\n` +
        "  academic-agent\n",
    );
    process.exit(1);
  }

  const logPath = `${repoRoot}/.academic-agent/core-${port}.log`;
  mkdirSync(`${repoRoot}/.academic-agent`, {recursive: true});
  const logFd = openSync(logPath, "a");
  const core = spawn(
    "conda",
    [
      "run",
      "-n",
      "academic-agent",
      "env",
      "PYTHONNOUSERSITE=1",
      "uvicorn",
      "academic_agent_core.api:app",
      "--app-dir",
      "services/core/src",
      "--host",
      url.hostname,
      "--port",
      port,
    ],
    {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    },
  );

  const ready = await waitForCompatibleCore(urlText, 10_000);
  if (!ready) {
    await stopProcessGroup(core);
    process.stderr.write(
      `Failed to start Academic Agent core at ${urlText}.\n` +
        `Log: ${logPath}\n` +
        `${tail(logPath)}\n`,
    );
    process.exit(1);
  }
  return core;
}

async function releasePort(port) {
  const pidsOutput = await commandOutput("lsof", [
    "-tiTCP:" + port,
    "-sTCP:LISTEN",
  ]);
  const pids = pidsOutput
    .split(/\s+/)
    .map((pid) => Number.parseInt(pid, 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

function commandOutput(command, commandArgs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const childProcess = spawn(command, commandArgs, {stdio: ["ignore", "pipe", "pipe"]});
    let stdout = "";
    let stderr = "";
    childProcess.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    childProcess.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    childProcess.on("error", rejectPromise);
    childProcess.on("exit", (code) => {
      if (code === 0 || code === 1) {
        resolvePromise(stdout);
        return;
      }
      rejectPromise(new Error(stderr || `${command} exited with ${code}`));
    });
  });
}

async function stopManagedCore() {
  if (!managedCore) {
    return;
  }
  await stopProcessGroup(managedCore);
  managedCore = null;
}

async function stopProcessGroup(processHandle) {
  if (!processHandle.pid || processHandle.exitCode !== null) {
    return;
  }
  try {
    process.kill(-processHandle.pid, "SIGTERM");
  } catch {
    return;
  }
  const exited = await waitForExit(processHandle, 1500);
  if (!exited) {
    try {
      process.kill(-processHandle.pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

function waitForExit(processHandle, timeoutMs) {
  return new Promise((resolvePromise) => {
    if (processHandle.exitCode !== null) {
      resolvePromise(true);
      return;
    }
    const timer = setTimeout(() => resolvePromise(false), timeoutMs);
    processHandle.once("exit", () => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });
}

async function isCoreReady(urlText) {
  try {
    const response = await fetch(`${urlText}/projects/status`);
    return response.ok;
  } catch {
    return false;
  }
}

async function coreCompatibility(urlText) {
  if (!(await isCoreReady(urlText))) {
    return {ready: false, compatible: false, reason: "Core is not ready."};
  }
  try {
    const response = await fetch(`${urlText}/capabilities`);
    if (!response.ok) {
      return {
        ready: true,
        compatible: false,
        reason: `Missing /capabilities endpoint (${response.status}).`,
      };
    }
    const payload = await response.json();
    const capabilities = Array.isArray(payload.capabilities) ? payload.capabilities : [];
    const missing = requiredCoreCapabilities.filter(
      (capability) => !capabilities.includes(capability),
    );
    return {
      ready: true,
      compatible: missing.length === 0,
      reason:
        missing.length === 0
          ? "Core is compatible."
          : `Missing core capability: ${missing.join(", ")}.`,
    };
  } catch (error) {
    return {
      ready: true,
      compatible: false,
      reason: `Could not read /capabilities: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    };
  }
}

async function waitForCompatibleCore(urlText, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await coreCompatibility(urlText)).compatible) {
      return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  return false;
}

async function waitForCoreDown(urlText, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isCoreReady(urlText))) {
      return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  return !(await isCoreReady(urlText));
}

function spawnPnpm(pnpmArgs, options) {
  return spawn("pnpm", ["--silent", "--dir", repoRoot, ...pnpmArgs], {
    cwd: repoRoot,
    ...options,
  });
}

function readRuntimeConfig() {
  const paths = configPaths();
  const runtime = {};
  for (const path of paths) {
    if (!existsSync(path)) {
      continue;
    }
    Object.assign(runtime, parseRuntimeSection(readFileSync(path, "utf8")));
  }
  return runtime;
}

function configPaths() {
  const paths = [];
  if (process.env.HOME) {
    paths.push(resolve(process.env.HOME, ".academic-agent", "config.toml"));
  }
  paths.push(resolve(repoRoot, ".academic-agent", "config.toml"));
  if (process.env.ACADEMIC_AGENT_CONFIG) {
    paths.push(resolve(process.env.ACADEMIC_AGENT_CONFIG));
  }
  return paths;
}

function parseRuntimeSection(text) {
  const runtime = {};
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (!line) {
      continue;
    }
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    if (section !== "runtime") {
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) {
      continue;
    }
    const key = assignment[1];
    const value = unquoteTomlValue(assignment[2].trim());
    if (key === "core_url") {
      runtime.coreUrl = value;
    } else if (key === "core_host") {
      runtime.coreHost = value;
    } else if (key === "core_port") {
      runtime.corePort = String(value);
    }
  }
  return runtime;
}

function unquoteTomlValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function tail(path) {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    return lines.slice(-20).join("\n");
  } catch (error) {
    return `${basename(path)} could not be read: ${error instanceof Error ? error.message : error}`;
  }
}
