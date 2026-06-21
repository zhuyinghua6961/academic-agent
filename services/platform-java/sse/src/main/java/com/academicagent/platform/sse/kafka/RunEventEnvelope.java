package com.academicagent.platform.sse.kafka;

import java.time.Instant;

public record RunEventEnvelope(
        String runId,
        String eventId,
        String eventType,
        int ordinal,
        Object payload,
        Instant createdAt,
        String traceId) {
}
