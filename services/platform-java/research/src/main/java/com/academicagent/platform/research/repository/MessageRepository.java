package com.academicagent.platform.research.repository;

import java.util.List;

import com.academicagent.platform.research.entity.Message;
import org.springframework.data.jpa.repository.JpaRepository;

public interface MessageRepository extends JpaRepository<Message, String> {

    List<Message> findByThreadIdOrderByCreatedAtAsc(String threadId);
}
