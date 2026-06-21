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
import com.academicagent.platform.research.repository.PaperEntryRepository;
import com.academicagent.platform.research.repository.PlanArtifactRepository;
import com.academicagent.platform.research.repository.PlanReviewRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PlanService {

    private final PlanArtifactRepository planArtifactRepository;
    private final PlanReviewRepository planReviewRepository;
    private final PaperEntryRepository paperEntryRepository;
    private final ThreadService threadService;
    private final ObjectMapper objectMapper;

    public PlanService(
            PlanArtifactRepository planArtifactRepository,
            PlanReviewRepository planReviewRepository,
            PaperEntryRepository paperEntryRepository,
            ThreadService threadService,
            ObjectMapper objectMapper) {
        this.planArtifactRepository = planArtifactRepository;
        this.planReviewRepository = planReviewRepository;
        this.paperEntryRepository = paperEntryRepository;
        this.threadService = threadService;
        this.objectMapper = objectMapper;
    }

    @Transactional(readOnly = true)
    public PlanArtifact getCurrentPlan(String userId, String threadId) {
        threadService.requireOwned(userId, threadId);
        return planArtifactRepository
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
        return planReviewRepository.save(review);
    }

    @Transactional
    public PlanArtifact freeze(String userId, String threadId) {
        PlanArtifact artifact = getCurrentPlan(userId, threadId);
        artifact.setFrozen(true);
        artifact.setStatus("frozen");
        artifact.setUpdatedAt(Instant.now());
        return planArtifactRepository.save(artifact);
    }

    @Transactional(readOnly = true)
    public List<Map<String, Object>> listPapers(String userId, String threadId) {
        threadService.requireOwned(userId, threadId);
        return paperEntryRepository.findByThreadIdAndUserIdOrderByCreatedAtAsc(threadId, userId).stream()
                .map(this::toPaperMap)
                .toList();
    }

    @Transactional
    public void upsertArtifactFromRun(String threadId, String userId, String artifactId, String bodyJson) {
        Instant now = Instant.now();
        PlanArtifact artifact = planArtifactRepository
                .findById(artifactId)
                .orElseGet(() -> {
                    PlanArtifact created = new PlanArtifact();
                    created.setArtifactId(artifactId);
                    created.setThreadId(threadId);
                    created.setUserId(userId);
                    created.setArtifactType("ResearchIdeaPlan");
                    created.setCreatedAt(now);
                    return created;
                });
        artifact.setBody(bodyJson);
        artifact.setStatus("active");
        artifact.setUpdatedAt(now);
        planArtifactRepository.save(artifact);
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
            paperEntryRepository.save(entry);
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
