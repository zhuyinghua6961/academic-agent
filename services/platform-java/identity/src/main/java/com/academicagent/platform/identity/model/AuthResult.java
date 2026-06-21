package com.academicagent.platform.identity.model;

public record AuthResult(String accessToken, String tokenType, long expiresIn, UserProfile user) {
}
