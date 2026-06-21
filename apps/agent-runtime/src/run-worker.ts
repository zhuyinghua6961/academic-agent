import type {Logger} from "pino";
import type {Producer} from "kafkajs";

import {ExperimentDesignRunner, IdeaPlanRunner, RunCancelled} from "@academic-agent/agent-core";
import {utcNow} from "@academic-agent/schemas";
import {PostgresWorkspace} from "@academic-agent/workspace-pg";

import type {AgentRuntimeConfig} from "./config.js";
import {applyRuntimeCredentials} from "./runtime-config.js";

export type RunExecuteCommand = {
  run_id: string;
  thread_id: string;
  user_id: string;
  project_id: string;
  idea: string;
  mode?: "idea_plan" | "experiment_design";
  trace_id: string;
  issued_at: string;
};

export type ExecutionContext = {
  run_id: string;
  thread_id: string;
  user_id: string;
  project_id: string;
  idea: string;
  mode: "idea_plan" | "experiment_design";
  trace_id: string;
  project_root: string;
  workspace_dir?: string;
  providers?: Record<string, {provider?: string; model?: string; api_key?: string; base_url?: string | null}>;
  search?: Array<{source?: string; api_key?: string}>;
};

export type RunEventEnvelope = {
  run_id: string;
  event_id: string;
  event_type: string;
  ordinal: number;
  payload: Record<string, unknown>;
  created_at: string;
  trace_id: string;
};

export type RunCompletedEvent = {
  run_id: string;
  status: "completed" | "failed" | "cancelled";
  artifact_id: string | null;
  error: string | null;
  trace_id: string;
  completed_at: string;
};

function parseRunExecuteCommand(raw: string): RunExecuteCommand {
  const payload: unknown = JSON.parse(raw);
  if (!payload || typeof payload !== "object") {
    throw new Error("run.execute payload must be an object");
  }
  const record = payload as Record<string, unknown>;
  const required = ["run_id", "thread_id", "user_id", "project_id", "idea", "trace_id", "issued_at"];
  for (const key of required) {
    if (typeof record[key] !== "string" || !String(record[key]).trim()) {
      throw new Error(`run.execute missing or invalid field: ${key}`);
    }
  }
  const mode = record.mode;
  if (mode !== undefined && mode !== "idea_plan" && mode !== "experiment_design") {
    throw new Error("run.execute mode must be idea_plan or experiment_design");
  }
  return {
    run_id: String(record.run_id),
    thread_id: String(record.thread_id),
    user_id: String(record.user_id),
    project_id: String(record.project_id),
    idea: String(record.idea),
    mode: mode as RunExecuteCommand["mode"],
    trace_id: String(record.trace_id),
    issued_at: String(record.issued_at),
  };
}

export async function fetchExecutionContext(
  config: AgentRuntimeConfig,
  runId: string,
  traceId: string,
  logger: Logger,
): Promise<ExecutionContext> {
  const url = `${config.platformInternalUrl}/api/internal/v1/runs/${encodeURIComponent(runId)}/execution-context`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.platformInternalToken}`,
      "X-Trace-Id": traceId,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to fetch execution context for run ${runId}: ${response.status} ${body}`,
    );
  }
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object") {
    throw new Error(`Invalid execution context for run ${runId}`);
  }
  const record = payload as Record<string, unknown>;
  return {
    run_id: String(record.run_id ?? runId),
    thread_id: String(record.thread_id),
    user_id: String(record.user_id),
    project_id: String(record.project_id),
    idea: String(record.idea),
    mode: (record.mode === "experiment_design" ? "experiment_design" : "idea_plan"),
    trace_id: String(record.trace_id ?? traceId),
    project_root: String(record.project_root),
    workspace_dir: record.workspace_dir ? String(record.workspace_dir) : undefined,
    providers:
      record.providers && typeof record.providers === "object"
        ? (record.providers as ExecutionContext["providers"])
        : undefined,
    search: Array.isArray(record.search)
      ? (record.search as ExecutionContext["search"])
      : undefined,
  };
}

function createWorkspace(config: AgentRuntimeConfig, context: ExecutionContext): PostgresWorkspace {
  return new PostgresWorkspace({
    databaseUrl: config.databaseUrl,
    projectId: context.project_id,
    projectRoot: context.project_root,
    workspaceDir: context.workspace_dir,
  });
}

async function publishEvent(
  producer: Producer,
  topic: string,
  envelope: RunEventEnvelope,
  logger: Logger,
): Promise<void> {
  await producer.send({
    topic,
    messages: [
      {
        key: envelope.run_id,
        value: JSON.stringify(envelope),
      },
    ],
  });
  logger.debug(
    {span: "kafka", runId: envelope.run_id, traceId: envelope.trace_id, eventType: envelope.event_type},
    "Published run event",
  );
}

async function publishCompleted(
  producer: Producer,
  topic: string,
  event: RunCompletedEvent,
  logger: Logger,
): Promise<void> {
  await producer.send({
    topic,
    messages: [
      {
        key: event.run_id,
        value: JSON.stringify(event),
      },
    ],
  });
  logger.info(
    {span: "kafka", runId: event.run_id, traceId: event.trace_id, status: event.status},
    "Published run.completed",
  );
}

async function mirrorRunEvents(
  workspace: PostgresWorkspace,
  producer: Producer,
  config: AgentRuntimeConfig,
  runId: string,
  traceId: string,
  logger: Logger,
): Promise<void> {
  const events = workspace.list_events(runId);
  for (const event of events) {
    await publishEvent(
      producer,
      config.kafkaEventsTopic,
      {
        run_id: event.run_id,
        event_id: event.event_id,
        event_type: event.event_type,
        ordinal: event.ordinal,
        payload: event.payload ?? {},
        created_at: event.created_at,
        trace_id: traceId,
      },
      logger,
    );
  }
}

export async function processRunExecuteMessage(
  config: AgentRuntimeConfig,
  producer: Producer,
  rawMessage: string,
  logger: Logger,
): Promise<void> {
  const command = parseRunExecuteCommand(rawMessage);
  const runLogger = logger.child({runId: command.run_id, traceId: command.trace_id, span: "agent"});

  runLogger.info({threadId: command.thread_id, projectId: command.project_id}, "Received run.execute");

  const context = await fetchExecutionContext(config, command.run_id, command.trace_id, runLogger);
  applyRuntimeCredentials({
    project_root: context.project_root,
    providers: context.providers,
    search: context.search,
  });
  const workspace = createWorkspace(config, context);
  workspace.ensure_initialized();
  workspace.create_thread(context.thread_id);

  const mode = context.mode ?? command.mode ?? "idea_plan";
  workspace.import_run(command.run_id, command.thread_id, command.idea, mode);

  const userMessages = workspace.list_messages(command.thread_id).filter((m) => m.role === "user");
  if (!userMessages.some((m) => m.run_id === command.run_id)) {
    workspace.add_message(command.thread_id, "user", command.idea, command.run_id);
  }

  try {
    if (mode === "experiment_design") {
      const runner = new ExperimentDesignRunner(workspace);
      await runner.execute_run(command.run_id);
      await mirrorRunEvents(workspace, producer, config, command.run_id, command.trace_id, runLogger);
      const completed = workspace.get_run(command.run_id);
      await publishCompleted(
        producer,
        config.kafkaCompletedTopic,
        {
          run_id: command.run_id,
          status: completed.status === "cancelled" ? "cancelled" : completed.status === "failed" ? "failed" : "completed",
          artifact_id: completed.artifact_id ?? null,
          error: completed.error ?? null,
          trace_id: command.trace_id,
          completed_at: utcNow(),
        },
        runLogger,
      );
      return;
    }

    const runner = new IdeaPlanRunner(workspace);
    const result = await runner.execute_run(command.run_id);
    await mirrorRunEvents(workspace, producer, config, command.run_id, command.trace_id, runLogger);
    await publishCompleted(
      producer,
      config.kafkaCompletedTopic,
      {
        run_id: command.run_id,
        status: "completed",
        artifact_id: result.run.artifact_id ?? null,
        error: null,
        trace_id: command.trace_id,
        completed_at: utcNow(),
      },
      runLogger,
    );
  } catch (error) {
    await mirrorRunEvents(workspace, producer, config, command.run_id, command.trace_id, runLogger).catch(
      () => undefined,
    );

    if (error instanceof RunCancelled) {
      await publishCompleted(
        producer,
        config.kafkaCompletedTopic,
        {
          run_id: command.run_id,
          status: "cancelled",
          artifact_id: null,
          error: String(error),
          trace_id: command.trace_id,
          completed_at: utcNow(),
        },
        runLogger,
      );
      return;
    }

    const failedRun = workspace.get_run(command.run_id);
    await publishCompleted(
      producer,
      config.kafkaCompletedTopic,
      {
        run_id: command.run_id,
        status: "failed",
        artifact_id: failedRun.artifact_id ?? null,
        error: failedRun.error ?? String(error),
        trace_id: command.trace_id,
        completed_at: utcNow(),
      },
      runLogger,
    );
    runLogger.error({err: error}, "Run execution failed");
  } finally {
    await workspace.close();
  }
}
