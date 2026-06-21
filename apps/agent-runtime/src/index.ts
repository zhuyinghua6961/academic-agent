import pino from "pino";

import {loadConfig} from "./config.js";
import {createKafkaClients, startConsumer} from "./kafka.js";
import {processRunExecuteMessage} from "./run-worker.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    level: config.logLevel,
    base: {service: "agent-runtime", span: "agent"},
  });

  logger.info("Starting agent-runtime");

  const {consumer, producer, disconnect} = await createKafkaClients(config, logger);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({signal}, "Shutting down agent-runtime");
    await disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  startConsumer(
    consumer,
    async ({message}) => {
      if (!message.value) {
        logger.warn({span: "kafka"}, "Skipping empty Kafka message");
        return;
      }
      const raw = message.value.toString("utf8");
      let traceId = "unknown";
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && typeof (parsed as {trace_id?: unknown}).trace_id === "string") {
          traceId = (parsed as {trace_id: string}).trace_id;
        }
      } catch {
        // trace id optional for malformed payloads
      }
      const messageLogger = logger.child({traceId, span: "agent"});
      await processRunExecuteMessage(config, producer, raw, messageLogger);
    },
    logger,
  );

  logger.info("agent-runtime is healthy and waiting for run.execute messages");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
