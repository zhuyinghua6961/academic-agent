package com.academicagent.platform.identity.service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.academicagent.platform.identity.crypto.AesEncryptionService;
import com.academicagent.platform.identity.entity.UserCredential;
import com.academicagent.platform.identity.model.DecryptedProviderCredential;
import com.academicagent.platform.identity.model.ProviderProfileMasked;
import com.academicagent.platform.identity.model.ProviderSettingsView;
import com.academicagent.platform.identity.repository.UserCredentialRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ProviderSettingsService {

    private static final List<String> PROFILES =
            List.of("planner", "reviewer", "writer", "extractor", "embedder");

    private final UserCredentialRepository credentialRepository;
    private final AesEncryptionService encryptionService;
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    public ProviderSettingsService(
            UserCredentialRepository credentialRepository, AesEncryptionService encryptionService) {
        this.credentialRepository = credentialRepository;
        this.encryptionService = encryptionService;
    }

    @Transactional(readOnly = true)
    public ProviderSettingsView getMasked(String userId) {
        List<UserCredential> stored = credentialRepository.findByUserId(userId);
        Map<String, ProviderProfileMasked> profiles = new LinkedHashMap<>();
        for (String profile : PROFILES) {
            UserCredential credential = stored.stream()
                    .filter(item -> profile.equals(item.getProfile()))
                    .findFirst()
                    .orElse(null);
            if (credential == null) {
                profiles.put(profile, new ProviderProfileMasked(null, null, false, null));
            } else {
                String hint = AesEncryptionService.maskApiKey(
                        encryptionService.decrypt(credential.getApiKeyEncrypted()));
                profiles.put(
                        profile,
                        new ProviderProfileMasked(
                                credential.getProvider(),
                                credential.getModel(),
                                true,
                                hint));
            }
        }
        boolean configured = stored.stream().anyMatch(c -> c.getApiKeyEncrypted() != null);
        return new ProviderSettingsView(configured, profiles);
    }

    @Transactional
    public ProviderSettingsView upsert(
            String userId, String profile, String provider, String model, String apiKey, String baseUrl) {
        Instant now = Instant.now();
        UserCredential credential = credentialRepository
                .findByUserIdAndProfile(userId, profile)
                .orElseGet(() -> {
                    UserCredential created = new UserCredential();
                    created.setCredentialId(UUID.randomUUID().toString());
                    created.setUserId(userId);
                    created.setProfile(profile);
                    created.setCreatedAt(now);
                    return created;
                });
        credential.setProvider(provider);
        credential.setModel(model);
        credential.setApiKeyEncrypted(encryptionService.encrypt(apiKey));
        credential.setBaseUrl(baseUrl);
        credential.setUpdatedAt(now);
        credentialRepository.save(credential);
        return getMasked(userId);
    }

    @Transactional(readOnly = true)
    public Map<String, DecryptedProviderCredential> getDecrypted(String userId) {
        Map<String, DecryptedProviderCredential> result = new LinkedHashMap<>();
        for (UserCredential credential : credentialRepository.findByUserId(userId)) {
            result.put(
                    credential.getProfile(),
                    new DecryptedProviderCredential(
                            credential.getProfile(),
                            credential.getProvider(),
                            credential.getModel(),
                            encryptionService.decrypt(credential.getApiKeyEncrypted()),
                            credential.getBaseUrl()));
        }
        return result;
    }

    public boolean verify(String provider, String model, String apiKey, String baseUrl) {
        if (provider == null || provider.isBlank() || model == null || model.isBlank()) {
            return false;
        }
        if (apiKey == null || apiKey.isBlank()) {
            return false;
        }
        String endpoint = resolveVerifyUrl(provider, baseUrl);
        if (endpoint == null) {
            return apiKey.length() >= 8;
        }
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(endpoint))
                    .timeout(Duration.ofSeconds(15))
                    .header("Authorization", "Bearer " + apiKey)
                    .header("Content-Type", "application/json")
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            return response.statusCode() < 500;
        } catch (Exception ex) {
            return false;
        }
    }

    private String resolveVerifyUrl(String provider, String baseUrl) {
        if (baseUrl != null && !baseUrl.isBlank()) {
            String normalized = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
            return normalized + "/models";
        }
        return switch (provider.toLowerCase()) {
            case "openai" -> "https://api.openai.com/v1/models";
            case "anthropic" -> "https://api.anthropic.com/v1/models";
            case "deepseek" -> "https://api.deepseek.com/models";
            default -> null;
        };
    }
}
