package com.academicagent.platform.api;

import java.util.LinkedHashMap;
import java.util.Map;

import com.academicagent.platform.research.entity.PlanArtifact;
import com.academicagent.platform.research.entity.PlanReview;
import com.academicagent.platform.research.service.PlanService;
import com.academicagent.platform.security.AuthenticatedUser;
import com.academicagent.platform.security.CurrentUserProvider;
import jakarta.validation.constraints.NotBlank;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/threads/{threadId}/plan")
public class PlanController {

    private final PlanService planService;
    private final CurrentUserProvider currentUserProvider;

    public PlanController(PlanService planService, CurrentUserProvider currentUserProvider) {
        this.planService = planService;
        this.currentUserProvider = currentUserProvider;
    }

    @GetMapping
    public Map<String, Object> getPlan(@PathVariable String threadId) {
        PlanArtifact artifact = planService.getCurrentPlan(userId(), threadId);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("artifact_id", artifact.getArtifactId());
        body.put("status", artifact.getStatus());
        body.put("body", planService.parseBody(artifact.getBody()));
        return body;
    }

    @PostMapping("/review")
    public Map<String, Object> review(@PathVariable String threadId, @RequestBody ReviewPlanRequest request) {
        PlanReview review = planService.submitReview(userId(), threadId, request.decision(), request.feedback());
        return Map.of("review_id", review.getReviewId(), "status", review.getStatus());
    }

    @PostMapping("/freeze")
    public Map<String, Object> freeze(@PathVariable String threadId) {
        PlanArtifact artifact = planService.freeze(userId(), threadId);
        return Map.of("artifact_id", artifact.getArtifactId(), "frozen", artifact.isFrozen());
    }

    private String userId() {
        AuthenticatedUser user = currentUserProvider.requireUser();
        return user.getUserId();
    }

    public record ReviewPlanRequest(@NotBlank String decision, String feedback) {}
}
