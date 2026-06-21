package com.academicagent.platform.identity.model;

import java.util.Map;

public record ProviderSettingsView(boolean configured, Map<String, ProviderProfileMasked> profiles) {
}
