package com.academicagent.platform.identity.model;

public record DecryptedProviderCredential(
        String profile, String provider, String model, String apiKey, String baseUrl) {
}
