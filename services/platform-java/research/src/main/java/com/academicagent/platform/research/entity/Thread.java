package com.academicagent.platform.research.entity;

import java.time.Instant;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(schema = "research", name = "threads")
public class Thread {

    @Id
    @Column(name = "thread_id", length = 36)
    private String threadId;

    @Column(name = "project_id", nullable = false, length = 36)
    private String projectId;

    @Column(name = "user_id", nullable = false, length = 36)
    private String userId;

    @Column(length = 255)
    private String name;

    @Column(name = "current_mode", nullable = false, length = 32)
    private String currentMode;

    @Column(name = "lifecycle_state", nullable = false, length = 64)
    private String lifecycleState;

    @Column(name = "idea_version")
    private Integer ideaVersion;

    @Column(name = "impact_level", length = 32)
    private String impactLevel;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    public String getThreadId() {
        return threadId;
    }

    public void setThreadId(String threadId) {
        this.threadId = threadId;
    }

    public String getProjectId() {
        return projectId;
    }

    public void setProjectId(String projectId) {
        this.projectId = projectId;
    }

    public String getUserId() {
        return userId;
    }

    public void setUserId(String userId) {
        this.userId = userId;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getCurrentMode() {
        return currentMode;
    }

    public void setCurrentMode(String currentMode) {
        this.currentMode = currentMode;
    }

    public String getLifecycleState() {
        return lifecycleState;
    }

    public void setLifecycleState(String lifecycleState) {
        this.lifecycleState = lifecycleState;
    }

    public Integer getIdeaVersion() {
        return ideaVersion;
    }

    public void setIdeaVersion(Integer ideaVersion) {
        this.ideaVersion = ideaVersion;
    }

    public String getImpactLevel() {
        return impactLevel;
    }

    public void setImpactLevel(String impactLevel) {
        this.impactLevel = impactLevel;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(Instant createdAt) {
        this.createdAt = createdAt;
    }
}
