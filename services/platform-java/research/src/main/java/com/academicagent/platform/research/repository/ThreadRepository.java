package com.academicagent.platform.research.repository;

import java.util.List;
import java.util.Optional;

import com.academicagent.platform.research.entity.Thread;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ThreadRepository extends JpaRepository<Thread, String> {

    List<Thread> findByUserIdAndProjectIdOrderByCreatedAtDesc(String userId, String projectId);

    @Query("SELECT t FROM Thread t WHERE t.userId = :userId ORDER BY t.createdAt DESC")
    List<Thread> findByUserIdOrderByCreatedAtDesc(@Param("userId") String userId);

    Optional<Thread> findByThreadIdAndUserId(String threadId, String userId);
}
