package com.academicagent.platform.research.service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.academicagent.platform.common.ApiException;
import com.academicagent.platform.research.entity.Message;
import com.academicagent.platform.research.entity.Thread;
import com.academicagent.platform.research.repository.MessageRepository;
import com.academicagent.platform.research.repository.ThreadRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ThreadService {

    private final ThreadRepository threadRepository;
    private final MessageRepository messageRepository;
    private final ProjectService projectService;

    public ThreadService(
            ThreadRepository threadRepository,
            MessageRepository messageRepository,
            ProjectService projectService) {
        this.threadRepository = threadRepository;
        this.messageRepository = messageRepository;
        this.projectService = projectService;
    }

    @Transactional(readOnly = true)
    public List<Thread> list(String userId, String projectId, int limit) {
        List<Thread> threads;
        if (projectId != null && !projectId.isBlank()) {
            threads = threadRepository.findByUserIdAndProjectIdOrderByCreatedAtDesc(userId, projectId);
        } else {
            threads = threadRepository.findByUserIdOrderByCreatedAtDesc(userId);
        }
        return threads.stream().limit(Math.max(1, limit)).toList();
    }

    @Transactional
    public Thread create(String userId, String projectId, String name, String mode) {
        projectService.requireOwned(userId, projectId);
        Thread thread = new Thread();
        thread.setThreadId(UUID.randomUUID().toString());
        thread.setProjectId(projectId);
        thread.setUserId(userId);
        thread.setName(name != null ? name : "New thread");
        thread.setCurrentMode(mode != null ? mode : "idea_plan");
        thread.setLifecycleState("active");
        thread.setIdeaVersion(0);
        thread.setCreatedAt(Instant.now());
        return threadRepository.save(thread);
    }

    @Transactional(readOnly = true)
    public Thread requireById(String threadId) {
        return threadRepository
                .findById(threadId)
                .orElseThrow(() -> new ApiException("Thread not found", HttpStatus.NOT_FOUND, "thread_not_found"));
    }

    @Transactional(readOnly = true)
    public Thread requireOwned(String userId, String threadId) {
        return threadRepository
                .findByThreadIdAndUserId(threadId, userId)
                .orElseThrow(() -> new ApiException("Thread not found", HttpStatus.NOT_FOUND, "thread_not_found"));
    }

    @Transactional
    public Thread rename(String userId, String threadId, String name) {
        Thread thread = requireOwned(userId, threadId);
        thread.setName(name);
        return threadRepository.save(thread);
    }

    @Transactional(readOnly = true)
    public String lastMessagePreview(String threadId) {
        List<Message> messages = messageRepository.findByThreadIdOrderByCreatedAtAsc(threadId);
        if (messages.isEmpty()) {
            return null;
        }
        String content = messages.get(messages.size() - 1).getContent();
        if (content.length() <= 120) {
            return content;
        }
        return content.substring(0, 117) + "...";
    }
}
