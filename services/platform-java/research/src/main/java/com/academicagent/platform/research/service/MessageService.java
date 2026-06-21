package com.academicagent.platform.research.service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.academicagent.platform.research.entity.Message;
import com.academicagent.platform.research.repository.MessageRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class MessageService {

    private final MessageRepository messageRepository;
    private final ThreadService threadService;

    public MessageService(MessageRepository messageRepository, ThreadService threadService) {
        this.messageRepository = messageRepository;
        this.threadService = threadService;
    }

    @Transactional(readOnly = true)
    public List<Message> list(String userId, String threadId) {
        threadService.requireOwned(userId, threadId);
        return messageRepository.findByThreadIdOrderByCreatedAtAsc(threadId);
    }

    @Transactional
    public Message addUserMessage(String userId, String threadId, String content) {
        threadService.requireOwned(userId, threadId);
        Message message = new Message();
        message.setMessageId(UUID.randomUUID().toString());
        message.setThreadId(threadId);
        message.setRole("user");
        message.setContent(content);
        message.setCreatedAt(Instant.now());
        return messageRepository.save(message);
    }
}
