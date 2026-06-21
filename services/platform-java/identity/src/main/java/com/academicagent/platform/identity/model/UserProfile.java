package com.academicagent.platform.identity.model;

import java.time.Instant;

public record UserProfile(String userId, String email, String displayName, Instant createdAt) {
}
