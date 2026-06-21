package com.academicagent.platform.api;

import java.util.List;
import java.util.Map;

import com.academicagent.platform.research.service.PlanService;
import com.academicagent.platform.security.AuthenticatedUser;
import com.academicagent.platform.security.CurrentUserProvider;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/threads/{threadId}/papers")
public class PaperController {

    private final PlanService planService;
    private final CurrentUserProvider currentUserProvider;

    public PaperController(PlanService planService, CurrentUserProvider currentUserProvider) {
        this.planService = planService;
        this.currentUserProvider = currentUserProvider;
    }

    @GetMapping
    public Map<String, Object> list(@PathVariable String threadId) {
        AuthenticatedUser user = currentUserProvider.requireUser();
        List<Map<String, Object>> papers = planService.listPapers(user.getUserId(), threadId);
        return Map.of("papers", papers);
    }
}
