export type AgentRuntimeConfig = {
  databaseUrl: string;
  kafkaBrokers: string[];
  kafkaGroupId: string;
  kafkaExecuteTopic: string;
  kafkaEventsTopic: string;
  kafkaCompletedTopic: string;
  platformInternalUrl: string;
  platformInternalToken: string;
  logLevel: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): AgentRuntimeConfig {
  const kafkaBrokers = (process.env.KAFKA_BROKERS ?? "localhost:9092")
    .split(",")
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);

  return {
    databaseUrl: required("DATABASE_URL"),
    kafkaBrokers,
    kafkaGroupId: process.env.KAFKA_GROUP_ID?.trim() || "academic-agent-agent-runtime",
    kafkaExecuteTopic: process.env.KAFKA_TOPIC_RUN_EXECUTE?.trim() || "run.execute",
    kafkaEventsTopic: process.env.KAFKA_TOPIC_RUN_EVENTS?.trim() || "run.events",
    kafkaCompletedTopic: process.env.KAFKA_TOPIC_RUN_COMPLETED?.trim() || "run.completed",
    platformInternalUrl: required("PLATFORM_INTERNAL_URL").replace(/\/$/, ""),
    platformInternalToken: required("PLATFORM_INTERNAL_TOKEN"),
    logLevel: process.env.LOG_LEVEL?.trim() || "info",
  };
}
