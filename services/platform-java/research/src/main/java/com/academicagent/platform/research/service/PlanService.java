package com.academicagent.platform.research.service;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.academicagent.platform.common.ApiException;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.academicagent.platform.research.entity.PaperEntry;
import com.academicagent.platform.research.entity.PlanArtifact;
import com.academicagent.platform.research.entity.PlanReview;
import com.academicagent.platform.research.mapper.PaperEntryMapper;
import com.academicagent.platform.research.mapper.PlanArtifactMapper;
import com.academicagent.platform.research.mapper.PlanReviewMapper;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PlanService {

    private final PlanArtifactMapper planArtifactMapper;
    private final PlanReviewMapper planReviewMapper;
    private final PaperEntryMapper paperEntryMapper;
    private final ThreadService threadService;
    private final ObjectMapper objectMapper;

    public PlanService(
            PlanArtifactMapper planArtifactMapper,
            PlanReviewMapper planReviewMapper,
            PaperEntryMapper paperEntryMapper,
            ThreadService threadService,
            ObjectMapper objectMapper) {
        this.planArtifactMapper = planArtifactMapper;
        this.planReviewMapper = planReviewMapper;
        this.paperEntryMapper = paperEntryMapper;
        this.threadService = threadService;
        this.objectMapper = objectMapper;
    }

    @Transactional(readOnly = true)
    public PlanArtifact getCurrentPlan(String userId, String threadId) {
        threadService.requireOwned(userId, threadId);
        return planArtifactMapper
                .findFirstByThreadIdAndUserIdOrderByUpdatedAtDesc(threadId, userId)
                .orElseThrow(() -> new ApiException("Plan not found", HttpStatus.NOT_FOUND, "plan_not_found"));
    }

    @Transactional
    public PlanReview submitReview(String userId, String threadId, String decision, String feedback) {
        threadService.requireOwned(userId, threadId);
        PlanReview review = new PlanReview();
        review.setReviewId(UUID.randomUUID().toString());
        review.setThreadId(threadId);
        review.setUserId(userId);
        review.setDecision(decision);
        review.setFeedback(feedback);
        review.setStatus("submitted");
        review.setCreatedAt(Instant.now());
        planReviewMapper.insert(review);
        return review;
    }

    @Transactional
    public PlanArtifact freeze(String userId, String threadId) {
        PlanArtifact artifact = getCurrentPlan(userId, threadId);
        artifact.setFrozen(true);
        artifact.setStatus("frozen");
        artifact.setUpdatedAt(Instant.now());
        planArtifactMapper.updateById(artifact);
        return artifact;
    }

    @Transactional(readOnly = true)
    public List<Map<String, Object>> listPapers(String userId, String threadId) {
        threadService.requireOwned(userId, threadId);
        return paperEntryMapper.findByThreadIdAndUserIdOrderByCreatedAtAsc(threadId, userId).stream()
                .map(this::toPaperMap)
                .toList();
    }

    @Transactional
    public void upsertArtifactFromRun(String threadId, String userId, String artifactId, String bodyJson) {
        Instant now = Instant.now();
        PlanArtifact artifact = planArtifactMapper.selectById(artifactId);
        boolean isNew = artifact == null;
        if (isNew) {
            artifact = new PlanArtifact();
            artifact.setArtifactId(artifactId);
            artifact.setThreadId(threadId);
            artifact.setUserId(userId);
            artifact.setArtifactType("ResearchIdeaPlan");
            artifact.setCreatedAt(now);
        }
        artifact.setBody(bodyJson);
        artifact.setStatus("active");
        artifact.setUpdatedAt(now);
        if (isNew) {
            planArtifactMapper.insert(artifact);
        } else {
            planArtifactMapper.updateById(artifact);
        }
    }

    @Transactional
    public void addPaper(String threadId, String userId, Map<String, Object> metadata) {
        try {
            PaperEntry entry = new PaperEntry();
            entry.setPaperId(UUID.randomUUID().toString());
            entry.setThreadId(threadId);
            entry.setUserId(userId);
            entry.setMetadata(objectMapper.writeValueAsString(metadata));
            entry.setCreatedAt(Instant.now());
            paperEntryMapper.insert(entry);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("failed to serialize paper metadata", ex);
        }
    }

    public Map<String, Object> parseBody(String bodyJson) {
        if (bodyJson == null || bodyJson.isBlank()) {
            return Map.of();
        }
        try {
            return objectMapper.readValue(bodyJson, new TypeReference<>() {});
        } catch (JsonProcessingException ex) {
            return Map.of("raw", bodyJson);
        }
    }

    private Map<String, Object> toPaperMap(PaperEntry entry) {
        try {
            Map<String, Object> metadata =
                    objectMapper.readValue(entry.getMetadata(), new TypeReference<>() {});
            metadata.putIfAbsent("paper_id", entry.getPaperId());
            return metadata;
        } catch (JsonProcessingException ex) {
            return Map.of("paper_id", entry.getPaperId());
        }
    }
}
