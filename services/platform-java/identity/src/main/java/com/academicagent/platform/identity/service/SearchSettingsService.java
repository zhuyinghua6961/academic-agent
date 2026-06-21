package com.academicagent.platform.identity.service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import com.academicagent.platform.identity.crypto.AesEncryptionService;
import com.academicagent.platform.identity.entity.SearchSetting;
import com.academicagent.platform.identity.model.DecryptedSearchCredential;
import com.academicagent.platform.identity.model.SearchSettingsView;
import com.academicagent.platform.identity.model.SearchSourceMasked;
import com.academicagent.platform.identity.repository.SearchSettingRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class SearchSettingsService {

    private static final List<String> KNOWN_SOURCES =
            List.of("arxiv", "openalex", "brave", "tavily", "serper", "serpapi", "duckduckgo");

    private final SearchSettingRepository searchSettingRepository;
    private final AesEncryptionService encryptionService;
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    public SearchSettingsService(
            SearchSettingRepository searchSettingRepository, AesEncryptionService encryptionService) {
        this.searchSettingRepository = searchSettingRepository;
        this.encryptionService = encryptionService;
    }

    @Transactional(readOnly = true)
    public SearchSettingsView getMasked(String userId) {
        List<SearchSetting> stored = searchSettingRepository.findByUserId(userId);
        List<SearchSourceMasked> sources = new ArrayList<>();
        for (String source : KNOWN_SOURCES) {
            SearchSetting setting = stored.stream()
                    .filter(item -> source.equals(item.getSource()))
                    .findFirst()
                    .orElse(null);
            if (setting == null) {
                sources.add(new SearchSourceMasked(source, false, null));
            } else {
                sources.add(new SearchSourceMasked(
                        source,
                        true,
                        AesEncryptionService.maskApiKey(encryptionService.decrypt(setting.getApiKeyEncrypted()))));
            }
        }
        boolean configured = !stored.isEmpty();
        return new SearchSettingsView(configured, sources);
    }

    @Transactional
    public SearchSettingsView upsert(String userId, String source, String apiKey) {
        Instant now = Instant.now();
        SearchSetting setting = searchSettingRepository
                .findByUserIdAndSource(userId, source)
                .orElseGet(() -> {
                    SearchSetting created = new SearchSetting();
                    created.setSettingId(UUID.randomUUID().toString());
                    created.setUserId(userId);
                    created.setSource(source);
                    created.setCreatedAt(now);
                    return created;
                });
        setting.setApiKeyEncrypted(encryptionService.encrypt(apiKey));
        setting.setUpdatedAt(now);
        searchSettingRepository.save(setting);
        return getMasked(userId);
    }

    @Transactional(readOnly = true)
    public List<DecryptedSearchCredential> getDecrypted(String userId) {
        return searchSettingRepository.findByUserId(userId).stream()
                .map(setting -> new DecryptedSearchCredential(
                        setting.getSource(), encryptionService.decrypt(setting.getApiKeyEncrypted())))
                .toList();
    }

    public boolean verify(String source, String apiKey) {
        if (source == null || source.isBlank() || apiKey == null || apiKey.isBlank()) {
            return false;
        }
        String endpoint = resolveVerifyUrl(source);
        if (endpoint == null) {
            return apiKey.length() >= 8;
        }
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder()
                    .uri(URI.create(endpoint))
                    .timeout(Duration.ofSeconds(15))
                    .GET();
            if ("brave".equals(source)) {
                builder.header("X-Subscription-Token", apiKey);
            } else if ("tavily".equals(source)) {
                return apiKey.length() >= 8;
            } else {
                builder.header("Authorization", "Bearer " + apiKey);
            }
            HttpResponse<String> response = httpClient.send(builder.build(), HttpResponse.BodyHandlers.ofString());
            return response.statusCode() < 500;
        } catch (Exception ex) {
            return false;
        }
    }

    private String resolveVerifyUrl(String source) {
        return switch (source.toLowerCase()) {
            case "brave" -> "https://api.search.brave.com/res/v1/web/search?q=test&count=1";
            case "openalex" -> "https://api.openalex.org/works?per_page=1";
            case "arxiv" -> "https://export.arxiv.org/api/query?search_query=all:test&max_results=1";
            default -> null;
        };
    }
}
