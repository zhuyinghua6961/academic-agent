package com.academicagent.platform.api;

import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.academicagent.platform.research.entity.Message;
import com.academicagent.platform.research.entity.Run;
import com.academicagent.platform.research.entity.Thread;
import com.academicagent.platform.research.service.MessageService;
import com.academicagent.platform.research.service.RunService;
import com.academicagent.platform.research.service.ThreadService;
import com.academicagent.platform.security.AuthenticatedUser;
import com.academicagent.platform.security.CurrentUserProvider;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/threads")
public class ThreadController {

    private static final DateTimeFormatter ISO = DateTimeFormatter.ISO_INSTANT;

    private final ThreadService threadService;
    private final MessageService messageService;
    private final RunService runService;
    private final CurrentUserProvider currentUserProvider;

    public ThreadController(
            ThreadService threadService,
            MessageService messageService,
            RunService runService,
            CurrentUserProvider currentUserProvider) {
        this.threadService = threadService;
        this.messageService = messageService;
        this.runService = runService;
        this.currentUserProvider = currentUserProvider;
    }

    @GetMapping
    public Map<String, Object> list(
            @RequestParam(value = "project_id", required = false) String projectId,
            @RequestParam(value = "limit", defaultValue = "50") int limit) {
        List<Map<String, Object>> threads = threadService.list(userId(), projectId, limit).stream()
                .map(this::toSession)
                .toList();
        return Map.of("threads", threads);
    }

    @PostMapping
    public ResponseEntity<Map<String, Object>> create(@RequestBody CreateThreadRequest request) {
        Thread thread = threadService.create(userId(), request.projectId(), request.name(), request.mode());
        return ResponseEntity.status(HttpStatus.CREATED).body(toThread(thread));
    }

    @GetMapping("/{threadId}")
    public Map<String, Object> get(@PathVariable String threadId) {
        return toThread(threadService.requireOwned(userId(), threadId));
    }

    @PatchMapping("/{threadId}")
    public Map<String, Object> rename(@PathVariable String threadId, @RequestBody RenameThreadRequest request) {
        return toThread(threadService.rename(userId(), threadId, request.name()));
    }

    @GetMapping("/{threadId}/messages")
    public Map<String, Object> listMessages(@PathVariable String threadId) {
        List<Map<String, Object>> messages =
                messageService.list(userId(), threadId).stream().map(this::toMessage).toList();
        return Map.of("messages", messages);
    }

    @PostMapping("/{threadId}/messages")
    public ResponseEntity<Map<String, Object>> sendMessage(
            @PathVariable String threadId, @RequestBody SendMessageRequest request) {
        String uid = userId();
        Thread thread = threadService.requireOwned(uid, threadId);
        messageService.addUserMessage(uid, threadId, request.content());
        Run run = runService.createAndPublish(uid, thread, request.content());
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(Map.of("run", toRun(run), "thread", toThread(thread)));
    }

    private String userId() {
        AuthenticatedUser user = currentUserProvider.requireUser();
        return user.getUserId();
    }

    private Map<String, Object> toSession(Thread thread) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("thread_id", thread.getThreadId());
        body.put("project_id", thread.getProjectId());
        body.put("title", thread.getName());
        body.put("created_at", ISO.format(thread.getCreatedAt()));
        body.put("status", thread.getLifecycleState());
        body.put("last_message_preview", threadService.lastMessagePreview(thread.getThreadId()));
        return body;
    }

    private Map<String, Object> toThread(Thread thread) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("thread_id", thread.getThreadId());
        body.put("project_id", thread.getProjectId());
        body.put("name", thread.getName());
        body.put("created_at", ISO.format(thread.getCreatedAt()));
        body.put("current_mode", thread.getCurrentMode());
        body.put("lifecycle_state", thread.getLifecycleState());
        body.put("idea_version", thread.getIdeaVersion());
        body.put("impact_level", thread.getImpactLevel());
        return body;
    }

    private Map<String, Object> toMessage(Message message) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("message_id", message.getMessageId());
        body.put("thread_id", message.getThreadId());
        body.put("role", message.getRole());
        body.put("content", message.getContent());
        body.put("created_at", ISO.format(message.getCreatedAt()));
        return body;
    }

    private Map<String, Object> toRun(Run run) {
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

    public record CreateThreadRequest(@NotBlank String projectId, String name, String mode) {}

    public record RenameThreadRequest(@NotBlank String name) {}

    public record SendMessageRequest(@NotBlank String content) {}
}
