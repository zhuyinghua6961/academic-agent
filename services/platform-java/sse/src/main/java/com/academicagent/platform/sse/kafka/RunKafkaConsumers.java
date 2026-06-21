package com.academicagent.platform.sse.kafka;

import java.util.HashMap;
import java.util.Map;

import com.academicagent.platform.research.service.RunEventService;
import com.academicagent.platform.research.service.RunService;
import com.academicagent.platform.sse.redis.RunEventBroadcaster;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class RunKafkaConsumers {

    private static final Logger log = LoggerFactory.getLogger(RunKafkaConsumers.class);

    private final RunEventService runEventService;
    private final RunService runService;
    private final RunEventBroadcaster broadcaster;
    private final ObjectMapper objectMapper;

    public RunKafkaConsumers(
            RunEventService runEventService,
            RunService runService,
            RunEventBroadcaster broadcaster,
            ObjectMapper objectMapper) {
        this.runEventService = runEventService;
        this.runService = runService;
        this.broadcaster = broadcaster;
        this.objectMapper = objectMapper;
    }

    @KafkaListener(
            topics = "${platform.kafka.topics.run-events:run.events}",
            groupId = "platform-sse",
            containerFactory = "runEventKafkaListenerContainerFactory")
    public void onRunEvent(RunEventEnvelope envelope) {
        MDC.put("span", "kafka");
        MDC.put("runId", envelope.runId());
        try {
            String payloadJson = serializePayload(envelope);
            runEventService.persist(
                    envelope.runId(),
                    envelope.eventId(),
                    envelope.eventType(),
                    envelope.ordinal(),
                    payloadJson);
            String ssePayload = buildSsePayload(envelope.eventId(), envelope.eventType(), envelope.ordinal(), payloadJson);
            broadcaster.publish(envelope.runId(), ssePayload);
            log.debug("run_event_forwarded runId={} eventId={}", envelope.runId(), envelope.eventId());
        } finally {
            MDC.remove("runId");
            MDC.put("span", "gateway");
        }
    }

    @KafkaListener(
            topics = "${platform.kafka.topics.run-completed:run.completed}",
            groupId = "platform-sse",
            containerFactory = "runCompletedKafkaListenerContainerFactory")
    public void onRunCompleted(RunCompletedEvent event) {
        MDC.put("span", "kafka");
        MDC.put("runId", event.runId());
        try {
            runService.applyCompletion(event.runId(), event.status(), event.artifactId(), event.error());
            Map<String, Object> payload = new HashMap<>();
            payload.put("status", event.status());
            payload.put("artifact_id", event.artifactId());
            payload.put("error", event.error());
            payload.put("completed_at", event.completedAt());
            String payloadJson;
            try {
                payloadJson = objectMapper.writeValueAsString(payload);
            } catch (JsonProcessingException ex) {
                payloadJson = "{}";
            }
            String ssePayload = buildSsePayload("completed-" + event.runId(), "run.completed", -1, payloadJson);
            broadcaster.publish(event.runId(), ssePayload);
            log.info("run_completed_forwarded runId={} status={}", event.runId(), event.status());
        } finally {
            MDC.remove("runId");
            MDC.put("span", "gateway");
        }
    }

    private String serializePayload(RunEventEnvelope envelope) {
        try {
            return objectMapper.writeValueAsString(envelope.payload());
        } catch (JsonProcessingException ex) {
            return "{}";
        }
    }

    private String buildSsePayload(String eventId, String eventType, int ordinal, String dataJson) {
        try {
            Map<String, Object> wrapper = new HashMap<>();
            wrapper.put("id", eventId);
            wrapper.put("event", eventType);
            wrapper.put("ordinal", ordinal);
            wrapper.put("data", objectMapper.readTree(dataJson));
            return objectMapper.writeValueAsString(wrapper);
        } catch (JsonProcessingException ex) {
            return "{\"id\":\"" + eventId + "\",\"event\":\"" + eventType + "\",\"data\":{}}";
        }
    }
}
