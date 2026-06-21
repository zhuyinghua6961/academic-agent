package com.academicagent.platform.api.internal;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.academicagent.platform.common.ApiException;
import com.academicagent.platform.identity.model.DecryptedProviderCredential;
import com.academicagent.platform.identity.model.DecryptedSearchCredential;
import com.academicagent.platform.identity.model.ExecutionContext;
import com.academicagent.platform.identity.service.ExecutionContextService;
import com.academicagent.platform.research.entity.Project;
import com.academicagent.platform.research.entity.Run;
import com.academicagent.platform.research.entity.Thread;
import com.academicagent.platform.research.repository.RunRepository;
import com.academicagent.platform.research.service.ProjectService;
import com.academicagent.platform.research.service.ThreadService;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/internal/v1")
public class InternalExecutionContextController {

    private final ExecutionContextService executionContextService;
    private final RunRepository runRepository;
    private final ThreadService threadService;
    private final ProjectService projectService;

    public InternalExecutionContextController(
            ExecutionContextService executionContextService,
            RunRepository runRepository,
            ThreadService threadService,
            ProjectService projectService) {
        this.executionContextService = executionContextService;
        this.runRepository = runRepository;
        this.threadService = threadService;
        this.projectService = projectService;
    }

    @GetMapping("/execution-context/{userId}")
    public Map<String, Object> getExecutionContext(@PathVariable String userId) {
        ExecutionContext context = executionContextService.build(userId);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("user_id", context.userId());
        body.put("providers", toProviders(context.providers()));
        body.put("search", toSearch(context.search()));
        return body;
    }

    @GetMapping("/runs/{runId}/execution-context")
    public Map<String, Object> getRunExecutionContext(@PathVariable String runId) {
        Run run = runRepository
                .findById(runId)
                .orElseThrow(() -> new ApiException("Run not found", HttpStatus.NOT_FOUND, "run_not_found"));
        Thread thread = threadService.requireById(run.getThreadId());
        Project project = projectService.requireById(thread.getProjectId());

        ExecutionContext credentials = executionContextService.build(run.getUserId());
        String workspaceRoot = Path.of("/var/academic-agent/workspaces", run.getUserId(), project.getProjectId())
                .toString();
        String workspaceDir = Path.of(workspaceRoot, ".academic-agent").toString();

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("run_id", run.getRunId());
        body.put("thread_id", run.getThreadId());
        body.put("user_id", run.getUserId());
        body.put("project_id", project.getProjectId());
        body.put("idea", run.getIdea());
        body.put("mode", thread.getCurrentMode());
        body.put("trace_id", run.getRunId());
        body.put("project_root", workspaceRoot);
        body.put("workspace_dir", workspaceDir);
        body.put("providers", toProviders(credentials.providers()));
        body.put("search", toSearch(credentials.search()));
        return body;
    }

    private Map<String, Object> toProviders(Map<String, DecryptedProviderCredential> providers) {
        Map<String, Object> result = new LinkedHashMap<>();
        providers.forEach((profile, credential) -> {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("profile", credential.profile());
            entry.put("provider", credential.provider());
            entry.put("model", credential.model());
            entry.put("api_key", credential.apiKey());
            entry.put("base_url", credential.baseUrl());
            result.put(profile, entry);
        });
        return result;
    }

    private List<Map<String, Object>> toSearch(List<DecryptedSearchCredential> search) {
        return search.stream()
                .map(item -> Map.<String, Object>of("source", item.source(), "api_key", item.apiKey()))
                .toList();
    }
}
