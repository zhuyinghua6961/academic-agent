package com.academicagent.platform.research.service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.academicagent.platform.research.entity.Message;
import com.academicagent.platform.research.mapper.MessageMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class MessageService {

    private final MessageMapper messageMapper;
    private final ThreadService threadService;

    public MessageService(MessageMapper messageMapper, ThreadService threadService) {
        this.messageMapper = messageMapper;
        this.threadService = threadService;
    }

    @Transactional(readOnly = true)
    public List<Message> list(String userId, String threadId) {
        threadService.requireOwned(userId, threadId);
        return messageMapper.findByThreadIdOrderByCreatedAtAsc(threadId);
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
        messageMapper.insert(message);
        return message;
    }
}
