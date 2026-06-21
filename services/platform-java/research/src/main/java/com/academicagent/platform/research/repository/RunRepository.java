package com.academicagent.platform.research.repository;

import java.util.List;
import java.util.Optional;

import com.academicagent.platform.research.entity.Run;
import org.springframework.data.jpa.repository.JpaRepository;

public interface RunRepository extends JpaRepository<Run, String> {

    Optional<Run> findByRunIdAndUserId(String runId, String userId);

    List<Run> findByThreadIdOrderByCreatedAtDesc(String threadId);
}
