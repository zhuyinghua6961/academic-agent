import {mkdtempSync, rmSync, writeFileSync, mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {AgentConfig, ConfigurationRequiredError} from "@academic-agent/config";
import {ProjectWorkspace} from "@academic-agent/workspace";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "academic-agent-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, {recursive: true, force: true});
    }
  }
});

function writeConfig(root: string, content: string): void {
  const dir = join(root, ".academic-agent");
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, "config.toml"), content, "utf8");
}

function writeEnv(dir: string, content: string): void {
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, ".env"), content, "utf8");
}

describe("setup config", () => {
  it("empty project has no planner and requires setup", () => {
    const root = makeTempRoot();
    const home = join(root, "home");
    new ProjectWorkspace(root).init();
    const config = AgentConfig.load(root, {HOME: home});

    expect(config.planner_or_none()).toBeNull();
    expect(config.setup_state()).toBe("unconfigured");
    expect(() => config.profile("planner")).toThrow(ConfigurationRequiredError);
  });

  it("legacy mock config is treated as unconfigured", () => {
    const root = makeTempRoot();
    writeConfig(
      root,
      '[providers.planner]\nprovider = "openai"\nmodel = "mock-idea-diagnoser-v0"\n',
    );
    const config = AgentConfig.load(root, {HOME: join(root, "home")});
    expect(config.planner_or_none()?.provider).toBe("openai");
    expect(config.setup_state()).toBe("invalid");
  });

  it("recorded provider counts as configured without API key", () => {
    const root = makeTempRoot();
    writeConfig(
      root,
      '[providers.planner]\nprovider = "openai"\nmodel = "gpt-4.1-mini"\napi_key_env = "TEST_KEY"\n',
    );
    const config = AgentConfig.load(root, {
      HOME: join(root, "home"),
      ACADEMIC_AGENT_RECORDED_PROVIDER: "1",
    });
    expect(config.setup_state()).toBe("configured");
  });

  it("reviewer and extractor inherit planner when omitted", () => {
    const root = makeTempRoot();
    writeConfig(
      root,
      '[providers.planner]\nprovider = "openai"\nmodel = "gpt-4.1-mini"\napi_key_env = "TEST_KEY"\n',
    );
    const config = AgentConfig.load(root, {HOME: join(root, "home")});
    expect(config.profile("reviewer").model).toBe("gpt-4.1-mini");
    expect(config.profile("reviewer").profile).toBe("reviewer");
    expect(config.profile("extractor").profile).toBe("extractor");
    expect(() => config.profile("embedder")).toThrow(ConfigurationRequiredError);
  });

  it("env precedence is process then project then global", () => {
    const root = makeTempRoot();
    const home = join(root, "home");
    writeEnv(join(home, ".academic-agent"), "OPENAI_API_KEY=global\n");
    writeEnv(join(root, ".academic-agent"), "OPENAI_API_KEY=project\n");

    const projectLoaded = AgentConfig.load(root, {HOME: home}).env;
    const processLoaded = AgentConfig.load(root, {
      HOME: home,
      OPENAI_API_KEY: "process",
    }).env;

    expect(projectLoaded.OPENAI_API_KEY).toBe("project");
    expect(processLoaded.OPENAI_API_KEY).toBe("process");
  });
});

describe("workspace", () => {
  it("creates thread, message, and run", () => {
    const root = makeTempRoot();
    const workspace = new ProjectWorkspace(root);
    workspace.init();
    const thread = workspace.create_thread();
    workspace.add_message(thread.thread_id, "user", "test idea");
    const run = workspace.create_run(thread.thread_id, "test idea");
    expect(run.thread_id).toBe(thread.thread_id);
    expect(workspace.list_messages(thread.thread_id)).toHaveLength(1);
  });
});
