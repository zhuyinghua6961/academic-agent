package com.academicagent.platform.research.repository;

import java.util.List;

import com.academicagent.platform.research.entity.Project;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ProjectRepository extends JpaRepository<Project, String> {

    List<Project> findByUserIdOrderByCreatedAtDesc(String userId);
}
