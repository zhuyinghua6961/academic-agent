import type {Logger} from "pino";
import {Kafka, type Consumer, type Producer, type EachMessagePayload} from "kafkajs";

import type {AgentRuntimeConfig} from "./config.js";

export type KafkaClients = {
  consumer: Consumer;
  producer: Producer;
  disconnect: () => Promise<void>;
};

export async function createKafkaClients(config: AgentRuntimeConfig, logger: Logger): Promise<KafkaClients> {
  const kafka = new Kafka({
    clientId: "academic-agent-agent-runtime",
    brokers: config.kafkaBrokers,
  });

  const consumer = kafka.consumer({groupId: config.kafkaGroupId});
  const producer = kafka.producer();

  await consumer.connect();
  await producer.connect();
  await consumer.subscribe({topic: config.kafkaExecuteTopic, fromBeginning: false});

  logger.info(
    {
      span: "kafka",
      brokers: config.kafkaBrokers,
      groupId: config.kafkaGroupId,
      executeTopic: config.kafkaExecuteTopic,
      eventsTopic: config.kafkaEventsTopic,
      completedTopic: config.kafkaCompletedTopic,
    },
    "Kafka consumer connected",
  );

  return {
    consumer,
    producer,
    disconnect: async () => {
      await consumer.disconnect();
      await producer.disconnect();
    },
  };
}

export type MessageHandler = (payload: EachMessagePayload) => Promise<void>;

export function startConsumer(consumer: Consumer, handler: MessageHandler, logger: Logger): void {
  void consumer.run({
    eachMessage: async (payload) => {
      try {
        await handler(payload);
      } catch (error) {
        logger.error(
          {
            span: "kafka",
            topic: payload.topic,
            partition: payload.partition,
            offset: payload.message.offset,
            err: error,
          },
          "Unhandled Kafka message handler error",
        );
      }
    },
  });
}
