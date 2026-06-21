package com.academicagent.platform.research.kafka;

import java.time.Instant;

public record RunExecuteCommand(
        String runId,
        String threadId,
        String userId,
        String projectId,
        String idea,
        String mode,
        String traceId,
        Instant issuedAt) {
}
