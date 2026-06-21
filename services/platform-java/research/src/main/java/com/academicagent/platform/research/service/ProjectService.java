package com.academicagent.platform.research.service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.academicagent.platform.common.ApiException;
import com.academicagent.platform.research.entity.Project;
import com.academicagent.platform.research.repository.ProjectRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ProjectService {

    private final ProjectRepository projectRepository;

    public ProjectService(ProjectRepository projectRepository) {
        this.projectRepository = projectRepository;
    }

    @Transactional(readOnly = true)
    public List<Project> list(String userId) {
        return projectRepository.findByUserIdOrderByCreatedAtDesc(userId);
    }

    @Transactional
    public Project create(String userId, String name) {
        Project project = new Project();
        project.setProjectId(UUID.randomUUID().toString());
        project.setUserId(userId);
        project.setName(name);
        project.setCreatedAt(Instant.now());
        return projectRepository.save(project);
    }

    @Transactional(readOnly = true)
    public Project requireById(String projectId) {
        return projectRepository
                .findById(projectId)
                .orElseThrow(() -> new ApiException("Project not found", HttpStatus.NOT_FOUND, "project_not_found"));
    }

    @Transactional(readOnly = true)
    public Project requireOwned(String userId, String projectId) {
        return projectRepository
                .findById(projectId)
                .filter(project -> userId.equals(project.getUserId()))
                .orElseThrow(() -> new ApiException("Project not found", HttpStatus.NOT_FOUND, "project_not_found"));
    }
}
