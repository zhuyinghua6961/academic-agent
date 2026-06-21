package com.academicagent.platform.identity.model;

import java.util.List;

public record SearchSettingsView(boolean configured, List<SearchSourceMasked> sources) {
}
