package com.academicagent.platform.identity.model;

public record ProviderProfileMasked(
        String provider, String model, boolean configured, String apiKeyHint) {
}
