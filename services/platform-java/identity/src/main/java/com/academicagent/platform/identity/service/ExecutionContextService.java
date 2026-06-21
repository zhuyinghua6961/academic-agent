package com.academicagent.platform.identity.service;

import com.academicagent.platform.identity.model.ExecutionContext;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ExecutionContextService {

    private final ProviderSettingsService providerSettingsService;
    private final SearchSettingsService searchSettingsService;

    public ExecutionContextService(
            ProviderSettingsService providerSettingsService, SearchSettingsService searchSettingsService) {
        this.providerSettingsService = providerSettingsService;
        this.searchSettingsService = searchSettingsService;
    }

    @Transactional(readOnly = true)
    public ExecutionContext build(String userId) {
        return new ExecutionContext(
                userId,
                providerSettingsService.getDecrypted(userId),
                searchSettingsService.getDecrypted(userId));
    }
}
