package com.academicagent.platform.security;

public class AuthenticatedUser {

    private final String userId;
    private final String email;

    public AuthenticatedUser(String userId, String email) {
        this.userId = userId;
        this.email = email;
    }

    public String getUserId() {
        return userId;
    }

    public String getEmail() {
        return email;
    }
}
