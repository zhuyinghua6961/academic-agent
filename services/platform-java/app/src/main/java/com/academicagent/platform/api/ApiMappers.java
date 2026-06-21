package com.academicagent.platform.api;

import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;

import com.academicagent.platform.identity.model.UserProfile;

public final class ApiMappers {

    private static final DateTimeFormatter ISO = DateTimeFormatter.ISO_INSTANT;

    private ApiMappers() {}

    public static Map<String, Object> userProfile(UserProfile profile) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("user_id", profile.userId());
        body.put("email", profile.email());
        body.put("display_name", profile.displayName());
        body.put("created_at", ISO.format(profile.createdAt()));
        return body;
    }
}
