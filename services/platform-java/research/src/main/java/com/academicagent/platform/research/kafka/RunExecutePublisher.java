package com.academicagent.platform.research.kafka;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

@Component
public class RunExecutePublisher {

    private static final Logger log = LoggerFactory.getLogger(RunExecutePublisher.class);
    public static final String TOPIC = "run.execute";

    private final KafkaTemplate<String, RunExecuteCommand> kafkaTemplate;
    private final String topic;

    public RunExecutePublisher(
            KafkaTemplate<String, RunExecuteCommand> kafkaTemplate,
            @Value("${platform.kafka.topics.run-execute:" + TOPIC + "}") String topic) {
        this.kafkaTemplate = kafkaTemplate;
        this.topic = topic;
    }

    public void publish(RunExecuteCommand command) {
        MDC.put("span", "kafka");
        try {
            kafkaTemplate.send(topic, command.runId(), command);
            log.info("run_execute_published runId={} threadId={}", command.runId(), command.threadId());
        } finally {
            MDC.put("span", "gateway");
        }
    }
}
