package com.academicagent.platform.research.repository;

import java.util.List;
import java.util.Optional;

import com.academicagent.platform.research.entity.PlanArtifact;
import org.springframework.data.jpa.repository.JpaRepository;

public interface PlanArtifactRepository extends JpaRepository<PlanArtifact, String> {

    Optional<PlanArtifact> findFirstByThreadIdAndUserIdOrderByUpdatedAtDesc(String threadId, String userId);

    List<PlanArtifact> findByThreadIdAndUserIdOrderByUpdatedAtDesc(String threadId, String userId);
}
