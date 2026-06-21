export const INIT_SCHEMA_SQL = `
  create table if not exists projects(
      project_id text primary key,
      project_root text not null,
      workspace_dir text not null,
      created_at text not null
  );

  create table if not exists threads(
      thread_id text primary key,
      project_id text not null,
      name text,
      created_at text not null,
      current_mode text not null default 'idea_plan',
      lifecycle_state text not null default 'lightweight_diagnosis',
      idea_version integer not null default 1,
      impact_level text not null default 'None'
  );

  create unique index if not exists threads_project_name_unique
  on threads(project_id, name);

  create table if not exists runs(
      run_id text primary key,
      thread_id text not null,
      mode text not null,
      status text not null,
      input_idea text not null,
      artifact_id text,
      error text,
      created_at text not null,
      updated_at text not null
  );

  create table if not exists messages(
      message_id text primary key,
      thread_id text not null,
      role text not null,
      content text not null,
      run_id text,
      created_at text not null,
      ordinal integer not null,
      tool_call_id text,
      tool_name text,
      tool_args_json text,
      parent_message_id text
  );

  create table if not exists events(
      event_id text primary key,
      run_id text not null,
      event_type text not null,
      payload_json text not null,
      created_at text not null,
      ordinal integer not null
  );

  create table if not exists artifacts(
      artifact_id text primary key,
      run_id text not null,
      artifact_type text not null,
      status text not null,
      title text not null,
      path text not null,
      metadata_path text not null,
      schema_version text not null,
      trace_refs_json text not null,
      created_at text not null
  );

  create table if not exists traces(
      trace_id text primary key,
      run_id text not null,
      trace_type text not null,
      path text not null,
      payload_hash text not null,
      created_at text not null
  );

  create table if not exists app_cache(
      cache_key text primary key,
      cache_type text not null,
      provider text not null,
      model text not null,
      profile text not null,
      prompt_version text not null,
      input_hash text not null,
      payload_json text not null,
      created_at text not null
  );

  create table if not exists idea_reviews(
      review_id text primary key,
      thread_id text not null,
      artifact_id text not null,
      run_id text not null,
      decision text not null,
      notes text,
      scores_json text,
      confidence text,
      created_at text not null
  );

  create table if not exists blueprint_reviews(
      review_id text primary key,
      thread_id text not null,
      artifact_id text not null,
      run_id text not null,
      decision text not null,
      notes text,
      created_at text not null
  );

  create table if not exists memory_records(
      record_id text primary key,
      thread_id text,
      record_type text not null,
      title text not null,
      summary text not null,
      source_refs_json text not null,
      artifact_refs_json text not null,
      status text not null,
      importance integer not null,
      created_at text not null,
      updated_at text not null
  );

  create table if not exists memory_index(
      record_id text primary key,
      search_text text not null,
      embedding_json text not null,
      source_hash text not null,
      updated_at text not null
  );

  create table if not exists conflict_records(
      conflict_id text primary key,
      thread_id text,
      conflict_type text not null,
      status text not null,
      summary text not null,
      record_refs_json text not null,
      source_refs_json text not null,
      created_at text not null,
      updated_at text not null
  );
`;
