package com.academicagent.platform.identity.model;

import java.util.List;
import java.util.Map;

public record ExecutionContext(
        String userId,
        Map<String, DecryptedProviderCredential> providers,
        List<DecryptedSearchCredential> search) {
}
