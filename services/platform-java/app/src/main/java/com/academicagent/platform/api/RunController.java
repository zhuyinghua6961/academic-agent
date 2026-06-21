package com.academicagent.platform.api;

import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;

import com.academicagent.platform.research.entity.Run;
import com.academicagent.platform.research.service.RunService;
import com.academicagent.platform.security.AuthenticatedUser;
import com.academicagent.platform.security.CurrentUserProvider;
import com.academicagent.platform.sse.service.SseStreamService;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
@RequestMapping("/api/v1/runs")
public class RunController {

    private static final DateTimeFormatter ISO = DateTimeFormatter.ISO_INSTANT;

    private final RunService runService;
    private final SseStreamService sseStreamService;
    private final CurrentUserProvider currentUserProvider;

    public RunController(
            RunService runService, SseStreamService sseStreamService, CurrentUserProvider currentUserProvider) {
        this.runService = runService;
        this.sseStreamService = sseStreamService;
        this.currentUserProvider = currentUserProvider;
    }

    @GetMapping("/{runId}")
    public Map<String, Object> get(@PathVariable String runId) {
        return toBody(runService.get(userId(), runId));
    }

    @PostMapping("/{runId}/cancel")
    public Map<String, Object> cancel(@PathVariable String runId) {
        return toBody(runService.cancel(userId(), runId));
    }

    @GetMapping(value = "/{runId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(
            @PathVariable String runId,
            @RequestHeader(value = "Last-Event-ID", required = false) String lastEventId) {
        return sseStreamService.stream(userId(), runId, lastEventId);
    }

    private String userId() {
        AuthenticatedUser user = currentUserProvider.requireUser();
        return user.getUserId();
    }

    private Map<String, Object> toBody(Run run) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("run_id", run.getRunId());
        body.put("thread_id", run.getThreadId());
        body.put("status", run.getStatus());
        body.put("idea", run.getIdea());
        body.put("artifact_id", run.getArtifactId());
        body.put("error", run.getError());
        body.put("created_at", ISO.format(run.getCreatedAt()));
        body.put("updated_at", ISO.format(run.getUpdatedAt()));
        return body;
    }
}
