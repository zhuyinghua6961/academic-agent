package com.academicagent.platform.api;

import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.academicagent.platform.research.entity.Project;
import com.academicagent.platform.research.service.ProjectService;
import com.academicagent.platform.security.AuthenticatedUser;
import com.academicagent.platform.security.CurrentUserProvider;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/projects")
public class ProjectController {

    private static final DateTimeFormatter ISO = DateTimeFormatter.ISO_INSTANT;

    private final ProjectService projectService;
    private final CurrentUserProvider currentUserProvider;

    public ProjectController(ProjectService projectService, CurrentUserProvider currentUserProvider) {
        this.projectService = projectService;
        this.currentUserProvider = currentUserProvider;
    }

    @GetMapping
    public Map<String, Object> list() {
        List<Map<String, Object>> projects =
                projectService.list(userId()).stream().map(this::toBody).toList();
        return Map.of("projects", projects);
    }

    @PostMapping
    public ResponseEntity<Map<String, Object>> create(@RequestBody CreateProjectRequest request) {
        Project project = projectService.create(userId(), request.name());
        return ResponseEntity.status(HttpStatus.CREATED).body(toBody(project));
    }

    private String userId() {
        AuthenticatedUser user = currentUserProvider.requireUser();
        return user.getUserId();
    }

    private Map<String, Object> toBody(Project project) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("project_id", project.getProjectId());
        body.put("name", project.getName());
        body.put("created_at", ISO.format(project.getCreatedAt()));
        return body;
    }

    public record CreateProjectRequest(@NotBlank String name) {}
}
