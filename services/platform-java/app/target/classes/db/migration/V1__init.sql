CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS research;
CREATE SCHEMA IF NOT EXISTS agent;

CREATE TABLE identity.users (
    user_id VARCHAR(36) PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    display_name VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE identity.user_credentials (
    credential_id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL REFERENCES identity.users(user_id) ON DELETE CASCADE,
    profile VARCHAR(32) NOT NULL,
    provider VARCHAR(64) NOT NULL,
    model VARCHAR(128) NOT NULL,
    api_key_encrypted TEXT NOT NULL,
    base_url VARCHAR(512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, profile)
);

CREATE TABLE identity.search_settings (
    setting_id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL REFERENCES identity.users(user_id) ON DELETE CASCADE,
    source VARCHAR(64) NOT NULL,
    api_key_encrypted TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, source)
);

CREATE TABLE research.projects (
    project_id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_projects_user ON research.projects(user_id);

CREATE TABLE research.threads (
    thread_id VARCHAR(36) PRIMARY KEY,
    project_id VARCHAR(36) NOT NULL REFERENCES research.projects(project_id) ON DELETE CASCADE,
    user_id VARCHAR(36) NOT NULL,
    name VARCHAR(255),
    current_mode VARCHAR(32) NOT NULL DEFAULT 'idea_plan',
    lifecycle_state VARCHAR(64) NOT NULL DEFAULT 'active',
    idea_version INTEGER DEFAULT 0,
    impact_level VARCHAR(32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_threads_user_project ON research.threads(user_id, project_id);

CREATE TABLE research.messages (
    message_id VARCHAR(36) PRIMARY KEY,
    thread_id VARCHAR(36) NOT NULL REFERENCES research.threads(thread_id) ON DELETE CASCADE,
    role VARCHAR(16) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_thread ON research.messages(thread_id, created_at);

CREATE TABLE research.runs (
    run_id VARCHAR(36) PRIMARY KEY,
    thread_id VARCHAR(36) NOT NULL REFERENCES research.threads(thread_id) ON DELETE CASCADE,
    user_id VARCHAR(36) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'queued',
    idea TEXT,
    artifact_id VARCHAR(36),
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_runs_user ON research.runs(user_id);
CREATE INDEX idx_runs_thread ON research.runs(thread_id);

CREATE TABLE research.run_events (
    event_id VARCHAR(36) PRIMARY KEY,
    run_id VARCHAR(36) NOT NULL REFERENCES research.runs(run_id) ON DELETE CASCADE,
    event_type VARCHAR(64) NOT NULL,
    ordinal INTEGER NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_run_events_run ON research.run_events(run_id, ordinal);

CREATE TABLE agent.artifacts (
    artifact_id VARCHAR(36) PRIMARY KEY,
    thread_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    artifact_type VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    body JSONB,
    frozen BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_artifacts_thread ON agent.artifacts(thread_id, user_id);

CREATE TABLE agent.plan_reviews (
    review_id VARCHAR(36) PRIMARY KEY,
    thread_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    decision VARCHAR(16) NOT NULL,
    feedback TEXT,
    status VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE agent.papers (
    paper_id VARCHAR(36) PRIMARY KEY,
    thread_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_papers_thread ON agent.papers(thread_id, user_id);
