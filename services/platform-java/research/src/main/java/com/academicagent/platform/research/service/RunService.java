package com.academicagent.platform.research.service;

import java.time.Instant;
import java.util.UUID;

import com.academicagent.platform.common.ApiException;
import com.academicagent.platform.common.TraceIdFilter;
import com.academicagent.platform.research.entity.Run;
import com.academicagent.platform.research.entity.Thread;
import com.academicagent.platform.research.kafka.RunExecuteCommand;
import com.academicagent.platform.research.kafka.RunExecutePublisher;
import com.academicagent.platform.research.repository.RunRepository;
import org.slf4j.MDC;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class RunService {

    private final RunRepository runRepository;
    private final ThreadService threadService;
    private final RunExecutePublisher runExecutePublisher;

    public RunService(
            RunRepository runRepository, ThreadService threadService, RunExecutePublisher runExecutePublisher) {
        this.runRepository = runRepository;
        this.threadService = threadService;
        this.runExecutePublisher = runExecutePublisher;
    }

    @Transactional(readOnly = true)
    public Run get(String userId, String runId) {
        return runRepository
                .findByRunIdAndUserId(runId, userId)
                .orElseThrow(() -> new ApiException("Run not found", HttpStatus.NOT_FOUND, "run_not_found"));
    }

    @Transactional
    public Run createAndPublish(String userId, Thread thread, String idea) {
        Instant now = Instant.now();
        Run run = new Run();
        run.setRunId(UUID.randomUUID().toString());
        run.setThreadId(thread.getThreadId());
        run.setUserId(userId);
        run.setStatus("queued");
        run.setIdea(idea);
        run.setCreatedAt(now);
        run.setUpdatedAt(now);
        runRepository.save(run);

        String traceId = MDC.get(TraceIdFilter.MDC_TRACE_ID);
        RunExecuteCommand command = new RunExecuteCommand(
                run.getRunId(),
                thread.getThreadId(),
                userId,
                thread.getProjectId(),
                idea,
                thread.getCurrentMode(),
                traceId != null ? traceId : UUID.randomUUID().toString(),
                now);
        runExecutePublisher.publish(command);
        return run;
    }

    @Transactional
    public Run cancel(String userId, String runId) {
        Run run = get(userId, runId);
        if ("completed".equals(run.getStatus()) || "failed".equals(run.getStatus())) {
            throw new ApiException("Run already finished", HttpStatus.CONFLICT, "run_finished");
        }
        run.setStatus("cancelled");
        run.setUpdatedAt(Instant.now());
        return runRepository.save(run);
    }

    @Transactional
    public void applyCompletion(String runId, String status, String artifactId, String error) {
        runRepository.findById(runId).ifPresent(run -> {
            run.setStatus(status);
            run.setArtifactId(artifactId);
            run.setError(error);
            run.setUpdatedAt(Instant.now());
            runRepository.save(run);
        });
    }
}
