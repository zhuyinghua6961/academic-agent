package com.academicagent.platform.research.service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.academicagent.platform.common.ApiException;
import com.academicagent.platform.research.entity.Project;
import com.academicagent.platform.research.mapper.ProjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ProjectService {

    private final ProjectMapper projectMapper;

    public ProjectService(ProjectMapper projectMapper) {
        this.projectMapper = projectMapper;
    }

    @Transactional(readOnly = true)
    public List<Project> list(String userId) {
        return projectMapper.findByUserIdOrderByCreatedAtDesc(userId);
    }

    @Transactional
    public Project create(String userId, String name) {
        Project project = new Project();
        project.setProjectId(UUID.randomUUID().toString());
        project.setUserId(userId);
        project.setName(name);
        project.setCreatedAt(Instant.now());
        projectMapper.insert(project);
        return project;
    }

    @Transactional(readOnly = true)
    public Project requireById(String projectId) {
        Project project = projectMapper.selectById(projectId);
        if (project == null) {
            throw new ApiException("Project not found", HttpStatus.NOT_FOUND, "project_not_found");
        }
        return project;
    }

    @Transactional(readOnly = true)
    public Project requireOwned(String userId, String projectId) {
        Project project = requireById(projectId);
        if (!userId.equals(project.getUserId())) {
            throw new ApiException("Project not found", HttpStatus.NOT_FOUND, "project_not_found");
        }
        return project;
    }
}
