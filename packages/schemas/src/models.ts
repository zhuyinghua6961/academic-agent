import {z} from "zod";

export const JsonObjectSchema = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObjectSchema>;

export const ProviderNameSchema = z.enum([
  "mock",
  "openai",
  "anthropic",
  "openai_compatible",
  "deepseek",
]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

export const ProviderProfileNameSchema = z.enum([
  "planner",
  "reviewer",
  "writer",
  "extractor",
  "embedder",
]);
export type ProviderProfileName = z.infer<typeof ProviderProfileNameSchema>;

export const ReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ReasoningSummarySchema = z.enum(["auto", "concise", "detailed"]);
export type ReasoningSummary = z.infer<typeof ReasoningSummarySchema>;

export const SearchSourceSchema = z.enum([
  "arxiv",
  "openalex",
  "brave",
  "tavily",
  "serper",
  "serpapi",
  "duckduckgo",
]);
export type SearchSource = z.infer<typeof SearchSourceSchema>;

export const PaperSearchSortSchema = z.enum(["relevance", "submitted_date", "hybrid"]);
export type PaperSearchSort = z.infer<typeof PaperSearchSortSchema>;

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const ProjectInitRequestSchema = strict({
  project_root: z.string().nullable().optional(),
});
export type ProjectInitRequest = z.infer<typeof ProjectInitRequestSchema>;

export const ProjectStatusSchema = strict({
  project_id: z.string(),
  project_root: z.string(),
  workspace_dir: z.string(),
  db_path: z.string(),
  initialized: z.boolean(),
  directories: z.array(z.string()).default([]),
});
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const CoreCapabilitiesResponseSchema = strict({
  version: z.string(),
  capabilities: z.array(z.string()).default([]),
});
export type CoreCapabilitiesResponse = z.infer<typeof CoreCapabilitiesResponseSchema>;

export const WorkflowThreadSchema = strict({
  thread_id: z.string(),
  project_id: z.string(),
  name: z.string().nullable().optional(),
  created_at: z.string(),
});
export type WorkflowThread = z.infer<typeof WorkflowThreadSchema>;

export const ThreadSessionSummarySchema = strict({
  thread_id: z.string(),
  project_id: z.string(),
  title: z.string(),
  name: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  message_count: z.number().int(),
  latest_run_id: z.string().nullable().optional(),
  latest_status: z.string().nullable().optional(),
  session_status: z.string().nullable().optional(),
  latest_artifact_type: z.string().nullable().optional(),
  latest_artifact_status: z.string().nullable().optional(),
});
export type ThreadSessionSummary = z.infer<typeof ThreadSessionSummarySchema>;

export const ThreadMessageSchema = strict({
  message_id: z.string(),
  thread_id: z.string(),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string(),
  run_id: z.string().nullable().optional(),
  created_at: z.string(),
  ordinal: z.number().int(),
  tool_call_id: z.string().nullable().optional(),
  tool_name: z.string().nullable().optional(),
  tool_args: JsonObjectSchema.nullable().optional(),
  parent_message_id: z.string().nullable().optional(),
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;

export const ModeRunSchema = strict({
  run_id: z.string(),
  thread_id: z.string(),
  mode: z.literal("idea_plan"),
  status: z.enum(["created", "running", "completed", "failed", "cancelled"]),
  input_idea: z.string(),
  artifact_id: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ModeRun = z.infer<typeof ModeRunSchema>;

export const DiagnosisSchema = strict({
  problem: z.string(),
  gap: z.string(),
  candidate_mechanism: z.string(),
  evidence_needed: z.array(z.string()),
  main_uncertainty: z.string(),
  clarifying_questions: z.array(z.string()).default([]),
});
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

export const ToolDefinitionSchema = strict({
  name: z.string(),
  description: z.string(),
  parameters: JsonObjectSchema,
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const ToolCallSchema = strict({
  call_id: z.string(),
  name: z.string(),
  arguments: JsonObjectSchema,
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolResultSchema = strict({
  call_id: z.string(),
  name: z.string(),
  result: JsonObjectSchema.nullable().optional(),
  error: z.string().nullable().optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const SearchResultSchema = strict({
  source: SearchSourceSchema,
  title: z.string(),
  snippet: z.string().default(""),
  url: z.string(),
  retrieved_at: z.string(),
  external_id: z.string().nullable().optional(),
  authors: z.array(z.string()).default([]),
  published_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  pdf_url: z.string().nullable().optional(),
  metadata: JsonObjectSchema.default({}),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchResponseSchema = strict({
  query: z.string(),
  source: z.string(),
  results: z.array(SearchResultSchema).default([]),
  retrieved_at: z.string(),
  error: z.string().nullable().optional(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const PaperSearchRequestSchema = strict({
  query: z.string().min(1),
  max_results: z.number().int().min(1).max(25).default(8),
  sources: z.array(SearchSourceSchema).default(["arxiv", "openalex"]),
  sort_by: PaperSearchSortSchema.default("hybrid"),
});
export type PaperSearchRequest = z.infer<typeof PaperSearchRequestSchema>;

export const SearchProviderStatusSchema = strict({
  source: SearchSourceSchema,
  enabled: z.boolean(),
  configured: z.boolean(),
  api_key_env: z.string().nullable().optional(),
  has_api_key: z.boolean(),
  base_url: z.string().nullable().optional(),
});
export type SearchProviderStatus = z.infer<typeof SearchProviderStatusSchema>;

export const SearchProvidersResponseSchema = strict({
  paper_sources: z.array(SearchSourceSchema).default([]),
  web_sources: z.array(SearchSourceSchema).default([]),
  providers: z.array(SearchProviderStatusSchema).default([]),
});
export type SearchProvidersResponse = z.infer<typeof SearchProvidersResponseSchema>;

export const ContextPacketSchema = strict({
  context_id: z.string(),
  mode: z.literal("idea_plan"),
  task: z.string(),
  idea: z.string(),
  relevant_artifacts: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  source_refs: z.array(z.string()).default([]),
  excluded_context_summary: z.string(),
  created_at: z.string(),
});
export type ContextPacket = z.infer<typeof ContextPacketSchema>;

export const ConversationSummarySchema = strict({
  summary_id: z.string(),
  thread_id: z.string(),
  status: z.literal("frozen"),
  schema_version: z.string(),
  summary_source: z.enum(["deterministic", "llm"]).default("deterministic"),
  provider: ProviderNameSchema.nullable().optional(),
  model: z.string().nullable().optional(),
  summary_text: z.string(),
  source_refs: z.array(z.string()).default([]),
  covered_until_ordinal: z.number().int(),
  covered_message_count: z.number().int(),
  markdown_path: z.string(),
  metadata_path: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const MemoryRecordSchema = strict({
  record_id: z.string(),
  thread_id: z.string().nullable().optional(),
  record_type: z.enum([
    "current_plan",
    "idea_review",
    "paper_evidence",
    "conversation_summary",
    "stale_recheck",
  ]),
  title: z.string(),
  summary: z.string(),
  source_refs: z.array(z.string()).default([]),
  artifact_refs: z.array(z.string()).default([]),
  status: z.enum(["active", "stale", "conflict"]).default("active"),
  importance: z.number().int().min(1).max(5).default(3),
  created_at: z.string(),
  updated_at: z.string(),
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const ProjectMemoryMapSchema = strict({
  project_id: z.string(),
  markdown_path: z.string(),
  metadata_path: z.string(),
  updated_at: z.string(),
  thread_count: z.number().int(),
  record_count: z.number().int(),
  source_refs: z.array(z.string()).default([]),
  records: z.array(MemoryRecordSchema).default([]),
});
export type ProjectMemoryMap = z.infer<typeof ProjectMemoryMapSchema>;

export const MemorySearchResultSchema = strict({
  record: MemoryRecordSchema,
  score: z.number(),
  vector_score: z.number(),
  keyword_score: z.number(),
  reason: z.string(),
});
export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;

export const MemorySearchResponseSchema = strict({
  query: z.string(),
  thread_id: z.string().nullable().optional(),
  results: z.array(MemorySearchResultSchema).default([]),
});
export type MemorySearchResponse = z.infer<typeof MemorySearchResponseSchema>;

export const ConflictRecordSchema = strict({
  conflict_id: z.string(),
  thread_id: z.string().nullable().optional(),
  conflict_type: z.enum([
    "review_decision_conflict",
    "freeze_gate_conflict",
    "stale_evidence_conflict",
  ]),
  status: z.enum(["open", "resolved"]).default("open"),
  summary: z.string(),
  record_refs: z.array(z.string()).default([]),
  source_refs: z.array(z.string()).default([]),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ConflictRecord = z.infer<typeof ConflictRecordSchema>;

export const ConflictListResponseSchema = strict({
  conflicts: z.array(ConflictRecordSchema).default([]),
});
export type ConflictListResponse = z.infer<typeof ConflictListResponseSchema>;

export const MemoryRecheckResponseSchema = strict({
  stale_count: z.number().int(),
  conflict_count: z.number().int(),
  memory_map: ProjectMemoryMapSchema,
});
export type MemoryRecheckResponse = z.infer<typeof MemoryRecheckResponseSchema>;

export const ArtifactMetadataSchema = strict({
  artifact_id: z.string(),
  artifact_type: z.enum(["ResearchIdeaPlanDraft", "ResearchIdeaPlan", "PaperSearchEvidence"]),
  status: z.enum(["draft", "frozen"]),
  title: z.string(),
  path: z.string(),
  metadata_path: z.string(),
  schema_version: z.string(),
  source_run_id: z.string(),
  trace_refs: z.array(z.string()).default([]),
  created_at: z.string(),
});
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

export const ResearchIdeaPlanDraftSchema = strict({
  artifact_id: z.string(),
  title: z.string(),
  source_run_id: z.string(),
  diagnosis: DiagnosisSchema,
  context_id: z.string(),
  markdown_path: z.string(),
  metadata_path: z.string(),
  created_at: z.string(),
});
export type ResearchIdeaPlanDraft = z.infer<typeof ResearchIdeaPlanDraftSchema>;

export const ResearchIdeaPlanSchema = strict({
  plan_id: z.string(),
  artifact_id: z.string(),
  source_draft_artifact_id: z.string(),
  source_run_id: z.string(),
  title: z.string(),
  diagnosis: DiagnosisSchema,
  context_id: z.string(),
  markdown_path: z.string(),
  metadata_path: z.string(),
  status: z.literal("frozen"),
  frozen_at: z.string(),
  created_at: z.string(),
});
export type ResearchIdeaPlan = z.infer<typeof ResearchIdeaPlanSchema>;

export const PaperSearchEvidenceSchema = strict({
  evidence_id: z.string(),
  artifact_id: z.string(),
  source_run_id: z.string(),
  query: z.string(),
  search_response: SearchResponseSchema,
  markdown_path: z.string(),
  metadata_path: z.string(),
  created_at: z.string(),
});
export type PaperSearchEvidence = z.infer<typeof PaperSearchEvidenceSchema>;

export const SSEEventSchema = strict({
  event_id: z.string(),
  run_id: z.string(),
  event_type: z.string(),
  payload: JsonObjectSchema.default({}),
  created_at: z.string(),
  ordinal: z.number().int(),
});
export type SSEEvent = z.infer<typeof SSEEventSchema>;

export const TraceRecordSchema = strict({
  trace_id: z.string(),
  run_id: z.string(),
  trace_type: z.string(),
  path: z.string(),
  payload_hash: z.string(),
  created_at: z.string(),
});
export type TraceRecord = z.infer<typeof TraceRecordSchema>;

export const ProviderRequestSchema = strict({
  request_id: z.string(),
  provider: ProviderNameSchema,
  model: z.string(),
  profile: ProviderProfileNameSchema,
  messages: z.array(JsonObjectSchema),
  prompt_version: z.string(),
  input_hash: z.string(),
  created_at: z.string(),
});
export type ProviderRequest = z.infer<typeof ProviderRequestSchema>;

export const ProviderResponseSchema = strict({
  response_id: z.string(),
  request_id: z.string(),
  provider: ProviderNameSchema,
  model: z.string(),
  output: JsonObjectSchema,
  usage: JsonObjectSchema.default({}),
  cached: z.boolean().default(false),
  provider_request_id: z.string().nullable().optional(),
  created_at: z.string(),
});
export type ProviderResponse = z.infer<typeof ProviderResponseSchema>;

export const ProviderProfileConfigSchema = strict({
  profile: ProviderProfileNameSchema,
  provider: ProviderNameSchema,
  model: z.string(),
  api_key_env: z.string().nullable().optional(),
  base_url: z.string().nullable().optional(),
  max_output_tokens: z.number().int().min(1).default(900),
  temperature: z.number().min(0).nullable().default(0.2),
  reasoning_effort: ReasoningEffortSchema.nullable().optional(),
  reasoning_summary: ReasoningSummarySchema.nullable().optional(),
  max_agent_iterations: z.number().int().min(1).max(20).default(5),
});
export type ProviderProfileConfig = z.infer<typeof ProviderProfileConfigSchema>;

export const ProviderProfileStatusSchema = strict({
  profile: ProviderProfileNameSchema,
  provider: ProviderNameSchema,
  model: z.string(),
  api_key_env: z.string().nullable().optional(),
  has_api_key: z.boolean(),
  base_url: z.string().nullable().optional(),
  reasoning_effort: ReasoningEffortSchema.nullable().optional(),
  reasoning_summary: ReasoningSummarySchema.nullable().optional(),
  live_enabled: z.boolean(),
  will_use_live: z.boolean(),
});
export type ProviderProfileStatus = z.infer<typeof ProviderProfileStatusSchema>;

export const ProviderProfilesResponseSchema = strict({
  profiles: z.array(ProviderProfileStatusSchema).default([]),
  config_sources: z.array(z.string()).default([]),
});
export type ProviderProfilesResponse = z.infer<typeof ProviderProfilesResponseSchema>;

export const AppCacheRecordSchema = strict({
  cache_key: z.string(),
  cache_type: z.string(),
  provider: ProviderNameSchema,
  model: z.string(),
  profile: ProviderProfileNameSchema,
  prompt_version: z.string(),
  input_hash: z.string(),
  payload_json: JsonObjectSchema,
  created_at: z.string(),
});
export type AppCacheRecord = z.infer<typeof AppCacheRecordSchema>;

export const AppCacheSummaryRecordSchema = strict({
  cache_key: z.string(),
  cache_type: z.string(),
  provider: ProviderNameSchema,
  model: z.string(),
  profile: ProviderProfileNameSchema,
  prompt_version: z.string(),
  input_hash: z.string(),
  created_at: z.string(),
});
export type AppCacheSummaryRecord = z.infer<typeof AppCacheSummaryRecordSchema>;

export const AppCacheListResponseSchema = strict({
  records: z.array(AppCacheSummaryRecordSchema).default([]),
});
export type AppCacheListResponse = z.infer<typeof AppCacheListResponseSchema>;

export const AppCacheClearResponseSchema = strict({
  deleted: z.number().int(),
});
export type AppCacheClearResponse = z.infer<typeof AppCacheClearResponseSchema>;

export const CreateIdeaPlanRunRequestSchema = strict({
  idea: z.string().min(1),
  thread_id: z.string().nullable().optional(),
});
export type CreateIdeaPlanRunRequest = z.infer<typeof CreateIdeaPlanRunRequestSchema>;

export const ContinueIdeaPlanThreadRequestSchema = strict({
  content: z.string().min(1),
});
export type ContinueIdeaPlanThreadRequest = z.infer<typeof ContinueIdeaPlanThreadRequestSchema>;

export const RenameThreadRequestSchema = strict({
  name: z.string().min(1),
});
export type RenameThreadRequest = z.infer<typeof RenameThreadRequestSchema>;

export const CreateIdeaPlanRunResponseSchema = strict({
  run: ModeRunSchema,
  artifact: ArtifactMetadataSchema,
  draft: ResearchIdeaPlanDraftSchema,
});
export type CreateIdeaPlanRunResponse = z.infer<typeof CreateIdeaPlanRunResponseSchema>;

export const StartIdeaPlanRunResponseSchema = strict({
  run: ModeRunSchema,
  run_url: z.string(),
  events_url: z.string(),
});
export type StartIdeaPlanRunResponse = z.infer<typeof StartIdeaPlanRunResponseSchema>;

export const RunListResponseSchema = strict({
  runs: z.array(ModeRunSchema).default([]),
});
export type RunListResponse = z.infer<typeof RunListResponseSchema>;

export const RunResultResponseSchema = strict({
  run: ModeRunSchema,
  artifact: ArtifactMetadataSchema,
  draft: ResearchIdeaPlanDraftSchema,
  thread: WorkflowThreadSchema,
  messages: z.array(ThreadMessageSchema).default([]),
});
export type RunResultResponse = z.infer<typeof RunResultResponseSchema>;

export const CurrentIdeaPlanResponseSchema = strict({
  thread: WorkflowThreadSchema,
  artifact: ArtifactMetadataSchema.nullable().optional(),
  draft: z
    .union([ResearchIdeaPlanDraftSchema, ResearchIdeaPlanSchema])
    .nullable()
    .optional(),
  session_status: z.string(),
  latest_run_id: z.string().nullable().optional(),
  latest_status: z.string().nullable().optional(),
});
export type CurrentIdeaPlanResponse = z.infer<typeof CurrentIdeaPlanResponseSchema>;

export const FreezeIdeaPlanResponseSchema = strict({
  thread: WorkflowThreadSchema,
  artifact: ArtifactMetadataSchema,
  plan: ResearchIdeaPlanSchema,
});
export type FreezeIdeaPlanResponse = z.infer<typeof FreezeIdeaPlanResponseSchema>;

export const ReviewIdeaPlanRequestSchema = strict({
  decision: z.enum(["Reject", "Revise", "Advance"]),
  notes: z.string().nullable().optional(),
});
export type ReviewIdeaPlanRequest = z.infer<typeof ReviewIdeaPlanRequestSchema>;

export const ReviewIdeaPlanResponseSchema = strict({
  thread: WorkflowThreadSchema,
  decision: z.enum(["Reject", "Revise", "Advance"]),
  session_status: z.string(),
  notes: z.string().nullable().optional(),
});
export type ReviewIdeaPlanResponse = z.infer<typeof ReviewIdeaPlanResponseSchema>;

export const ThreadMessagesResponseSchema = strict({
  thread: WorkflowThreadSchema,
  messages: z.array(ThreadMessageSchema).default([]),
});
export type ThreadMessagesResponse = z.infer<typeof ThreadMessagesResponseSchema>;

export const ContextUsageResponseSchema = strict({
  thread_id: z.string().nullable().optional(),
  model: z.string(),
  context_window_tokens: z.number().int(),
  history_token_budget: z.number().int(),
  compact_threshold_tokens: z.number().int(),
  compact_trigger_ratio: z.number(),
  max_history_tokens: z.number().int(),
  estimated_thread_tokens: z.number().int(),
  estimated_artifact_tokens: z.number().int(),
  estimated_draft_tokens: z.number().int(),
  estimated_total_tokens: z.number().int(),
  estimated_context_tokens: z.number().int(),
  usage_ratio: z.number(),
  threshold_ratio: z.number(),
  should_compact: z.boolean(),
  compact_reason: z.string(),
  context_focus: z.string(),
  total_message_count: z.number().int(),
  recent_message_count: z.number().int(),
  older_message_count: z.number().int(),
  important_message_count: z.number().int(),
  artifact_source_count: z.number().int(),
  chars_per_token: z.number(),
});
export type ContextUsageResponse = z.infer<typeof ContextUsageResponseSchema>;

export const ArtifactContextResponseSchema = strict({
  prompt_text: z.string(),
  source_refs: z.array(z.string()).default([]),
  estimated_tokens: z.number().int(),
  token_budget: z.number().int(),
});
export type ArtifactContextResponse = z.infer<typeof ArtifactContextResponseSchema>;

export const ThreadContextResponseSchema = strict({
  thread: WorkflowThreadSchema,
  artifact_context: ArtifactContextResponseSchema,
  content: z.string(),
});
export type ThreadContextResponse = z.infer<typeof ThreadContextResponseSchema>;

export const ThreadListResponseSchema = strict({
  threads: z.array(ThreadSessionSummarySchema).default([]),
});
export type ThreadListResponse = z.infer<typeof ThreadListResponseSchema>;

export const ArtifactReadResponseSchema = strict({
  metadata: ArtifactMetadataSchema,
  content: z.string(),
});
export type ArtifactReadResponse = z.infer<typeof ArtifactReadResponseSchema>;

export const TraceReadResponseSchema = strict({
  trace: TraceRecordSchema,
  payload: JsonObjectSchema,
});
export type TraceReadResponse = z.infer<typeof TraceReadResponseSchema>;

export const MemoryMapResponseSchema = strict({
  memory_map: ProjectMemoryMapSchema,
  content: z.string(),
});
export type MemoryMapResponse = z.infer<typeof MemoryMapResponseSchema>;

export const SetupStateSchema = z.enum(["unconfigured", "invalid", "configured"]);
export type SetupState = z.infer<typeof SetupStateSchema>;

export const SetupProviderNameSchema = z.enum([
  "openai",
  "anthropic",
  "deepseek",
  "openai_compatible",
]);
export type SetupProviderName = z.infer<typeof SetupProviderNameSchema>;

export const SetupKeyedSearchSourceSchema = z.enum(["brave", "tavily", "serper", "serpapi"]);
export type SetupKeyedSearchSource = z.infer<typeof SetupKeyedSearchSourceSchema>;

export const SetupLlmCandidateSchema = strict({
  provider: SetupProviderNameSchema,
  model: z.string().min(1),
  base_url: z.string().nullable().optional(),
  api_key_env: z.string().min(1),
});
export type SetupLlmCandidate = z.infer<typeof SetupLlmCandidateSchema>;

export const SetupProviderOptionSchema = strict({
  provider: SetupProviderNameSchema,
  label: z.string(),
  default_model: z.string(),
  default_api_key_env: z.string(),
  default_base_url: z.string().nullable().optional(),
  requires_base_url: z.boolean().default(false),
});
export type SetupProviderOption = z.infer<typeof SetupProviderOptionSchema>;

export const SetupSearchStatusSchema = strict({
  source: SearchSourceSchema,
  label: z.string(),
  keyed: z.boolean(),
  configured: z.boolean(),
  has_api_key: z.boolean(),
  enabled: z.boolean(),
  verification_required: z.boolean(),
});
export type SetupSearchStatus = z.infer<typeof SetupSearchStatusSchema>;

export const SetupStatusResponseSchema = strict({
  state: SetupStateSchema,
  setup_required: z.boolean(),
  planner: SetupLlmCandidateSchema.nullable().optional(),
  has_api_key: z.boolean(),
  provider_options: z.array(SetupProviderOptionSchema).default([]),
  search: z.array(SetupSearchStatusSchema).default([]),
});
export type SetupStatusResponse = z.infer<typeof SetupStatusResponseSchema>;

export const SetupVerifyErrorCategorySchema = z.enum([
  "authentication_failed",
  "model_unavailable",
  "rate_limited",
  "network_failed",
  "timeout",
  "provider_error",
]);
export type SetupVerifyErrorCategory = z.infer<typeof SetupVerifyErrorCategorySchema>;

export const SetupVerifyLlmRequestSchema = strict({
  candidate: SetupLlmCandidateSchema,
  api_key: z.string().optional(),
  use_stored_key: z.boolean().default(false),
});
export type SetupVerifyLlmRequest = z.infer<typeof SetupVerifyLlmRequestSchema>;

export const SetupVerifyLlmResponseSchema = strict({
  verified: z.boolean(),
  verification_id: z.string().nullable().optional(),
  error_category: SetupVerifyErrorCategorySchema.nullable().optional(),
  message: z.string().nullable().optional(),
});
export type SetupVerifyLlmResponse = z.infer<typeof SetupVerifyLlmResponseSchema>;

export const SetupVerifySearchRequestSchema = strict({
  source: SetupKeyedSearchSourceSchema,
  api_key: z.string().optional(),
  use_stored_key: z.boolean().default(false),
});
export type SetupVerifySearchRequest = z.infer<typeof SetupVerifySearchRequestSchema>;

export const SetupVerifySearchResponseSchema = strict({
  verified: z.boolean(),
  verification_id: z.string().nullable().optional(),
  error_category: SetupVerifyErrorCategorySchema.nullable().optional(),
  message: z.string().nullable().optional(),
});
export type SetupVerifySearchResponse = z.infer<typeof SetupVerifySearchResponseSchema>;

export const SetupApplyRequestSchema = strict({
  llm_verification_id: z.string().min(1),
  candidate: SetupLlmCandidateSchema,
  api_key: z.string().optional(),
  use_stored_key: z.boolean().default(false),
  search_verification_ids: z.record(z.string(), z.string()).default({}),
  search_api_keys: z.record(z.string(), z.string()).default({}),
  enabled_search_sources: z.array(SearchSourceSchema).default([]),
});
export type SetupApplyRequest = z.infer<typeof SetupApplyRequestSchema>;

export const SetupApplyResponseSchema = SetupStatusResponseSchema;
export type SetupApplyResponse = z.infer<typeof SetupApplyResponseSchema>;
