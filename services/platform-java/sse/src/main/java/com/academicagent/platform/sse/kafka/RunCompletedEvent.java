package com.academicagent.platform.sse.kafka;

import java.time.Instant;

public record RunCompletedEvent(
        String runId,
        String status,
        String artifactId,
        String error,
        String traceId,
        Instant completedAt) {
}
