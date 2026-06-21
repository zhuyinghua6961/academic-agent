package com.academicagent.platform.sse.service;

import java.io.IOException;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

import com.academicagent.platform.common.ApiException;
import com.academicagent.platform.research.entity.Run;
import com.academicagent.platform.research.entity.RunEvent;
import com.academicagent.platform.research.service.RunEventService;
import com.academicagent.platform.research.service.RunService;
import com.academicagent.platform.sse.redis.RunEventBroadcaster;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@Service
public class SseStreamService {

    private static final Logger log = LoggerFactory.getLogger(SseStreamService.class);
    private static final long SSE_TIMEOUT_MS = Duration.ofHours(2).toMillis();

    private final RunService runService;
    private final RunEventService runEventService;
    private final RedisMessageListenerContainer listenerContainer;
    private final ObjectMapper objectMapper;
    private final Map<String, CopyOnWriteArrayList<SseEmitter>> emittersByRun = new ConcurrentHashMap<>();
    private final Set<String> subscribedRuns = ConcurrentHashMap.newKeySet();

    public SseStreamService(
            RunService runService,
            RunEventService runEventService,
            RedisMessageListenerContainer listenerContainer,
            ObjectMapper objectMapper) {
        this.runService = runService;
        this.runEventService = runEventService;
        this.listenerContainer = listenerContainer;
        this.objectMapper = objectMapper;
    }

    public SseEmitter stream(String userId, String runId, String lastEventId) {
        Run run = runService.get(userId, runId);
        MDC.put("runId", run.getRunId());
        SseEmitter emitter = new SseEmitter(SSE_TIMEOUT_MS);
        emittersByRun.computeIfAbsent(runId, key -> new CopyOnWriteArrayList<>()).add(emitter);

        emitter.onCompletion(() -> removeEmitter(runId, emitter));
        emitter.onTimeout(() -> removeEmitter(runId, emitter));
        emitter.onError(ex -> removeEmitter(runId, emitter));

        ensureRedisSubscription(runId);

        replayHistory(runId, lastEventId, emitter);

        if (isTerminal(run.getStatus())) {
            sendTerminal(emitter, run);
            emitter.complete();
            removeEmitter(runId, emitter);
        }
        return emitter;
    }

    private void ensureRedisSubscription(String runId) {
        if (!subscribedRuns.add(runId)) {
            return;
        }
        String channel = RunEventBroadcaster.channel(runId);
        listenerContainer.addMessageListener(
                (MessageListener) (Message message, byte[] pattern) -> forwardRedisMessage(runId, message),
                new ChannelTopic(channel));
    }

    private void forwardRedisMessage(String runId, Message message) {
        String body = new String(message.getBody());
        List<SseEmitter> emitters = emittersByRun.getOrDefault(runId, new CopyOnWriteArrayList<>());
        for (SseEmitter emitter : emitters) {
            try {
                Map<String, Object> envelope = objectMapper.readValue(body, Map.class);
                String eventId = String.valueOf(envelope.get("id"));
                String eventType = String.valueOf(envelope.get("event"));
                Object data = envelope.get("data");
                emitter.send(SseEmitter.event()
                        .id(eventId)
                        .name(eventType)
                        .data(data, MediaType.APPLICATION_JSON));
                if ("run.completed".equals(eventType)) {
                    emitter.complete();
                    removeEmitter(runId, emitter);
                }
            } catch (IOException ex) {
                log.warn("sse_send_failed runId={}", runId, ex);
                emitter.completeWithError(ex);
                removeEmitter(runId, emitter);
            }
        }
    }

    private void replayHistory(String runId, String lastEventId, SseEmitter emitter) {
        List<RunEvent> events = runEventService.listFrom(runId, lastEventId);
        for (RunEvent event : events) {
            try {
                Object data = objectMapper.readTree(event.getPayload());
                emitter.send(SseEmitter.event()
                        .id(event.getEventId())
                        .name(event.getEventType())
                        .data(data, MediaType.APPLICATION_JSON));
            } catch (IOException ex) {
                throw new ApiException("Failed to replay events", HttpStatus.INTERNAL_SERVER_ERROR, "sse_replay_error");
            }
        }
    }

    private void sendTerminal(SseEmitter emitter, Run run) {
        try {
            Map<String, Object> payload = Map.of(
                    "status", run.getStatus(),
                    "artifact_id", run.getArtifactId(),
                    "error", run.getError());
            emitter.send(SseEmitter.event()
                    .id("terminal-" + run.getRunId())
                    .name("run.completed")
                    .data(payload, MediaType.APPLICATION_JSON));
        } catch (IOException ex) {
            emitter.completeWithError(ex);
        }
    }

    private boolean isTerminal(String status) {
        return "completed".equals(status) || "failed".equals(status) || "cancelled".equals(status);
    }

    private void removeEmitter(String runId, SseEmitter emitter) {
        CopyOnWriteArrayList<SseEmitter> emitters = emittersByRun.get(runId);
        if (emitters != null) {
            emitters.remove(emitter);
            if (emitters.isEmpty()) {
                emittersByRun.remove(runId);
            }
        }
        MDC.remove("runId");
    }
}
