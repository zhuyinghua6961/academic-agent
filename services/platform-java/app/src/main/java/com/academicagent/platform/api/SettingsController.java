package com.academicagent.platform.api;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.academicagent.platform.identity.model.ProviderProfileMasked;
import com.academicagent.platform.identity.model.ProviderSettingsView;
import com.academicagent.platform.identity.model.SearchSettingsView;
import com.academicagent.platform.identity.model.SearchSourceMasked;
import com.academicagent.platform.identity.service.ProviderSettingsService;
import com.academicagent.platform.identity.service.SearchSettingsService;
import com.academicagent.platform.security.AuthenticatedUser;
import com.academicagent.platform.security.CurrentUserProvider;
import jakarta.validation.constraints.NotBlank;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/settings")
public class SettingsController {

    private final ProviderSettingsService providerSettingsService;
    private final SearchSettingsService searchSettingsService;
    private final CurrentUserProvider currentUserProvider;

    public SettingsController(
            ProviderSettingsService providerSettingsService,
            SearchSettingsService searchSettingsService,
            CurrentUserProvider currentUserProvider) {
        this.providerSettingsService = providerSettingsService;
        this.searchSettingsService = searchSettingsService;
        this.currentUserProvider = currentUserProvider;
    }

    @GetMapping("/providers")
    public Map<String, Object> getProviders() {
        return providerBody(providerSettingsService.getMasked(userId()));
    }

    @PutMapping("/providers")
    public Map<String, Object> putProviders(@RequestBody ProviderSettingsRequest request) {
        ProviderSettingsView view = providerSettingsService.upsert(
                userId(), request.profile(), request.provider(), request.model(), request.apiKey(), request.baseUrl());
        return providerBody(view);
    }

    @PostMapping("/providers/verify")
    public Map<String, Object> verifyProvider(@RequestBody VerifyProviderRequest request) {
        boolean ok = providerSettingsService.verify(
                request.provider(), request.model(), request.apiKey(), request.baseUrl());
        return verifyBody(ok, ok ? "Provider connection verified" : "Provider verification failed");
    }

    @GetMapping("/search")
    public Map<String, Object> getSearch() {
        return searchBody(searchSettingsService.getMasked(userId()));
    }

    @PutMapping("/search")
    public Map<String, Object> putSearch(@RequestBody SearchSettingsRequest request) {
        SearchSettingsView view = searchSettingsService.upsert(userId(), request.source(), request.apiKey());
        return searchBody(view);
    }

    @PostMapping("/search/verify")
    public Map<String, Object> verifySearch(@RequestBody VerifySearchRequest request) {
        boolean ok = searchSettingsService.verify(request.source(), request.apiKey());
        return verifyBody(ok, ok ? "Search provider verified" : "Search verification failed");
    }

    private String userId() {
        AuthenticatedUser user = currentUserProvider.requireUser();
        return user.getUserId();
    }

    private Map<String, Object> providerBody(ProviderSettingsView view) {
        Map<String, Object> profiles = new LinkedHashMap<>();
        view.profiles().forEach((key, value) -> profiles.put(key, maskedProfile(value)));
        return Map.of("configured", view.configured(), "profiles", profiles);
    }

    private Map<String, Object> maskedProfile(ProviderProfileMasked profile) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("provider", profile.provider());
        body.put("model", profile.model());
        body.put("configured", profile.configured());
        body.put("api_key_hint", profile.apiKeyHint());
        return body;
    }

    private Map<String, Object> searchBody(SearchSettingsView view) {
        List<Map<String, Object>> sources = view.sources().stream().map(this::maskedSource).toList();
        return Map.of("configured", view.configured(), "sources", sources);
    }

    private Map<String, Object> maskedSource(SearchSourceMasked source) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("source", source.source());
        body.put("configured", source.configured());
        body.put("api_key_hint", source.apiKeyHint());
        return body;
    }

    private Map<String, Object> verifyBody(boolean ok, String message) {
        return Map.of("ok", ok, "message", message);
    }

    public record ProviderSettingsRequest(
            @NotBlank String profile,
            @NotBlank String provider,
            @NotBlank String model,
            @NotBlank String apiKey,
            String baseUrl) {}

    public record VerifyProviderRequest(
            @NotBlank String profile,
            @NotBlank String provider,
            @NotBlank String model,
            @NotBlank String apiKey,
            String baseUrl) {}

    public record SearchSettingsRequest(@NotBlank String source, @NotBlank String apiKey) {}

    public record VerifySearchRequest(@NotBlank String source, @NotBlank String apiKey) {}
}
