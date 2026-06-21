import {z} from "zod";

import {DiagnosisSchema, SearchResponseSchema} from "./models.js";

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const WorkflowModeSchema = z.enum(["idea_plan", "experiment_design"]);
export type WorkflowMode = z.infer<typeof WorkflowModeSchema>;

export const LifecycleStateSchema = z.enum([
  "idle",
  "lightweight_diagnosis",
  "idea_understanding",
  "human_agent_reading",
  "innovation_hook_mining",
  "candidate_idea_review",
  "research_idea_plan_freeze",
  "experiment_design",
  "paused",
]);
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;

export const ImpactLevelSchema = z.enum(["None", "Minor", "Major", "Fatal"]);
export type ImpactLevel = z.infer<typeof ImpactLevelSchema>;

export const PublicationStatusSchema = z.enum([
  "preprint",
  "accepted",
  "published",
  "unknown",
]);
export type PublicationStatus = z.infer<typeof PublicationStatusSchema>;

export const ReviewDecisionSchema = z.enum([
  "Reject",
  "Revise",
  "Advance",
  "Provisional",
]);
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export const BlueprintReviewDecisionSchema = z.enum(["Reject", "Revise", "Freeze"]);
export type BlueprintReviewDecision = z.infer<typeof BlueprintReviewDecisionSchema>;

export const ReadingModeSchema = z.enum(["quick", "guided", "exam"]);
export type ReadingMode = z.infer<typeof ReadingModeSchema>;

export const ArtifactTypeSchema = z.enum([
  "ResearchIdeaPlanDraft",
  "ResearchIdeaPlan",
  "PaperSearchEvidence",
  "PaperMiniReview",
  "InnovationHook",
  "DisagreementLog",
  "IdeaMetaReview",
  "ClosestWorkMatrix",
  "ExperimentBlueprintDraft",
  "ExperimentBlueprint",
  "ExperimentMetaReview",
]);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ClosestWorkEntrySchema = strict({
  paper_id: z.string().nullable().optional(),
  title: z.string(),
  status: PublicationStatusSchema.default("unknown"),
  mechanism: z.string().default(""),
  claim: z.string().default(""),
  evidence: z.string().default(""),
  gap_for_us: z.string().default(""),
  novelty_risk: z.string().default(""),
});
export type ClosestWorkEntry = z.infer<typeof ClosestWorkEntrySchema>;

export const PlanFeasibilitySchema = strict({
  compute: z.string().default(""),
  data: z.string().default(""),
  annotation: z.string().default(""),
  timeline: z.string().default(""),
  low_compute_validation: z.string().default(""),
  ideal_extended_validation: z.string().default(""),
});
export type PlanFeasibility = z.infer<typeof PlanFeasibilitySchema>;

export const PlanAssumptionsSchema = strict({
  user_confirmed: z.array(z.string()).default([]),
  agent_inferred: z.array(z.string()).default([]),
  to_verify: z.array(z.string()).default([]),
});
export type PlanAssumptions = z.infer<typeof PlanAssumptionsSchema>;

export const ResearchIdeaPlanBodySchema = strict({
  main_claim: z.string().default(""),
  mechanism_sketch: z.string().default(""),
  why_non_trivial: z.string().default(""),
  why_not_engineering_stitching: z.string().default(""),
  falsification_condition: z.string().default(""),
  closest_related_work: z.array(ClosestWorkEntrySchema).default([]),
  feasibility: PlanFeasibilitySchema.default({
    compute: "",
    data: "",
    annotation: "",
    timeline: "",
    low_compute_validation: "",
    ideal_extended_validation: "",
  }),
  compute_profile: z.string().default(""),
  data_profile: z.string().default(""),
  target_standard: z.string().default("AI/ML top-tier conference"),
  ethics: z.string().default(""),
  reproducibility: z.string().default(""),
  assumptions: PlanAssumptionsSchema.default({
    user_confirmed: [],
    agent_inferred: [],
    to_verify: [],
  }),
});
export type ResearchIdeaPlanBody = z.infer<typeof ResearchIdeaPlanBodySchema>;

export const ReviewScoresSchema = strict({
  originality: z.number().int().min(0).max(6).default(0),
  significance: z.number().int().min(0).max(6).default(0),
  soundness: z.number().int().min(0).max(6).default(0),
  clarity: z.number().int().min(0).max(6).default(0),
  feasibility_resource_fit: z.number().int().min(0).max(6).default(0),
});
export type ReviewScores = z.infer<typeof ReviewScoresSchema>;

export const PaperManifestEntrySchema = strict({
  paper_id: z.string(),
  local_path: z.string(),
  title: z.string().default(""),
  doi: z.string().nullable().optional(),
  arxiv_id: z.string().nullable().optional(),
  notes: z.string().default(""),
  ingest_status: z.enum(["pending", "ready", "failed"]).default("pending"),
  publication_status: PublicationStatusSchema.default("unknown"),
  linked_evidence_ids: z.array(z.string()).default([]),
  human_read: z.boolean().default(false),
  created_at: z.string(),
  updated_at: z.string(),
});
export type PaperManifestEntry = z.infer<typeof PaperManifestEntrySchema>;

export const PaperMiniReviewSchema = strict({
  review_id: z.string(),
  artifact_id: z.string(),
  source_run_id: z.string(),
  paper_id: z.string().nullable().optional(),
  title: z.string(),
  status: PublicationStatusSchema.default("unknown"),
  summary: z.string().default(""),
  strengths: z.array(z.string()).default([]),
  weaknesses: z.array(z.string()).default([]),
  questions: z.array(z.string()).default([]),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
  innovation_hooks: z.array(z.string()).default([]),
  novelty_risk_for_idea: z.string().default(""),
  markdown_path: z.string(),
  metadata_path: z.string(),
  created_at: z.string(),
});
export type PaperMiniReview = z.infer<typeof PaperMiniReviewSchema>;

export const ClosestWorkMatrixSchema = strict({
  matrix_id: z.string(),
  artifact_id: z.string(),
  source_run_id: z.string(),
  thread_id: z.string(),
  entries: z.array(ClosestWorkEntrySchema).default([]),
  markdown_path: z.string(),
  metadata_path: z.string(),
  created_at: z.string(),
});
export type ClosestWorkMatrix = z.infer<typeof ClosestWorkMatrixSchema>;

export const InnovationHookSchema = strict({
  hook_id: z.string(),
  artifact_id: z.string(),
  source_run_id: z.string(),
  trigger_paper: z.string(),
  unsolved_problem: z.string(),
  candidate_mechanism: z.string(),
  why_non_trivial: z.string(),
  validation_path: z.string(),
  novelty_risk: z.string(),
  human_feedback: z.string().default(""),
  markdown_path: z.string(),
  metadata_path: z.string(),
  created_at: z.string(),
});
export type InnovationHook = z.infer<typeof InnovationHookSchema>;

export const DisagreementLogSchema = strict({
  log_id: z.string(),
  artifact_id: z.string(),
  source_run_id: z.string(),
  topic: z.string(),
  user_position: z.string(),
  agent_position: z.string(),
  evidence_for_user: z.array(z.string()).default([]),
  evidence_for_agent: z.array(z.string()).default([]),
  current_resolution: z.string().default(""),
  verification_task: z.string().default(""),
  impact_on_idea_version: ImpactLevelSchema.default("None"),
  status: z.enum(["open", "resolved"]).default("open"),
  markdown_path: z.string(),
  metadata_path: z.string(),
  created_at: z.string(),
});
export type DisagreementLog = z.infer<typeof DisagreementLogSchema>;

export const IdeaMetaReviewSchema = strict({
  meta_review_id: z.string(),
  artifact_id: z.string(),
  source_run_id: z.string(),
  candidate: z.string(),
  decision: ReviewDecisionSchema,
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
  evidence_summary: z.string().default(""),
  closest_related_work: z.string().default(""),
  main_disagreements: z.array(z.string()).default([]),
  resolution_of_disagreements: z.string().default(""),
  remaining_risks: z.array(z.string()).default([]),
  why_not_engineering_stitching: z.string().default(""),
  conditions_for_freeze: z.array(z.string()).default([]),
  can_freeze: z.boolean().default(false),
  markdown_path: z.string(),
  metadata_path: z.string(),
  created_at: z.string(),
});
export type IdeaMetaReview = z.infer<typeof IdeaMetaReviewSchema>;

export const ClaimEvidenceEntrySchema = strict({
  claim: z.string(),
  evidence_needed: z.string(),
  support_result: z.string(),
  weaken_result: z.string(),
  falsify_result: z.string(),
  required_experiment: z.string(),
});
export type ClaimEvidenceEntry = z.infer<typeof ClaimEvidenceEntrySchema>;

export const ExperimentSetEntrySchema = strict({
  name: z.string(),
  tier: z.enum(["must-have", "should-have", "ideal"]),
  purpose: z.string(),
  supports_claim: z.string(),
});
export type ExperimentSetEntry = z.infer<typeof ExperimentSetEntrySchema>;

export const ExperimentBlueprintBodySchema = strict({
  linked_plan_id: z.string(),
  main_claim: z.string().default(""),
  claim_evidence_map: z.array(ClaimEvidenceEntrySchema).default([]),
  experiment_set: z.array(ExperimentSetEntrySchema).default([]),
  resources_must: z.array(z.string()).default([]),
  resources_should: z.array(z.string()).default([]),
  resources_ideal: z.array(z.string()).default([]),
  reproducibility: z.string().default(""),
  review_notes: z.string().default(""),
});
export type ExperimentBlueprintBody = z.infer<typeof ExperimentBlueprintBodySchema>;

export const ExperimentBlueprintDraftSchema = strict({
  artifact_id: z.string(),
  title: z.string(),
  source_run_id: z.string(),
  linked_plan_artifact_id: z.string(),
  body: ExperimentBlueprintBodySchema,
  markdown_path: z.string(),
  metadata_path: z.string(),
  created_at: z.string(),
});
export type ExperimentBlueprintDraft = z.infer<typeof ExperimentBlueprintDraftSchema>;

export const ExperimentBlueprintSchema = strict({
  blueprint_id: z.string(),
  artifact_id: z.string(),
  source_draft_artifact_id: z.string(),
  source_run_id: z.string(),
  title: z.string(),
  linked_plan_artifact_id: z.string(),
  body: ExperimentBlueprintBodySchema,
  markdown_path: z.string(),
  metadata_path: z.string(),
  status: z.literal("frozen"),
  frozen_at: z.string(),
  created_at: z.string(),
});
export type ExperimentBlueprint = z.infer<typeof ExperimentBlueprintSchema>;

export const ExperimentMetaReviewSchema = strict({
  meta_review_id: z.string(),
  artifact_id: z.string(),
  source_run_id: z.string(),
  can_move_to_execution: z.boolean().default(false),
  baseline_risks: z.array(z.string()).default([]),
  metric_risks: z.array(z.string()).default([]),
  remaining_risks: z.array(z.string()).default([]),
  conditions_for_freeze: z.array(z.string()).default([]),
  markdown_path: z.string(),
  metadata_path: z.string(),
  created_at: z.string(),
});
export type ExperimentMetaReview = z.infer<typeof ExperimentMetaReviewSchema>;

export const SubagentRoleSchema = z.enum([
  "paper_reader",
  "novelty_reviewer",
  "research_mentor",
  "candidate_reviewer",
  "ac_meta_review",
  "experiment_architect",
  "baseline_reviewer",
  "metric_reviewer",
  "experiment_ac",
]);
export type SubagentRole = z.infer<typeof SubagentRoleSchema>;

export const HandoffPacketSchema = strict({
  packet_id: z.string(),
  thread_id: z.string(),
  run_id: z.string(),
  role: SubagentRoleSchema,
  task: z.string(),
  allowed_tools: z.array(z.string()).default([]),
  payload: z.record(z.string(), z.unknown()).default({}),
  source_refs: z.array(z.string()).default([]),
  output_schema: z.string(),
  created_at: z.string(),
});
export type HandoffPacket = z.infer<typeof HandoffPacketSchema>;

export const SubagentReportSchema = strict({
  packet_id: z.string(),
  role: SubagentRoleSchema,
  status: z.enum(["completed", "failed"]).default("completed"),
  output: z.record(z.string(), z.unknown()).default({}),
  source_refs: z.array(z.string()).default([]),
  error: z.string().nullable().optional(),
  created_at: z.string(),
});
export type SubagentReport = z.infer<typeof SubagentReportSchema>;

export const PaperReadingReportSchema = strict({
  problem: z.string().default(""),
  mechanism: z.string().default(""),
  evidence: z.string().default(""),
  limitation: z.string().default(""),
  citations: z.array(z.string()).default([]),
});
export type PaperReadingReport = z.infer<typeof PaperReadingReportSchema>;

export const NoveltyReviewReportSchema = strict({
  novelty_risk: z.string().default(""),
  closest_work_notes: z.array(z.string()).default([]),
});
export type NoveltyReviewReport = z.infer<typeof NoveltyReviewReportSchema>;

export const CandidateIdeaReviewSchema = strict({
  decision: ReviewDecisionSchema,
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
  scores: ReviewScoresSchema,
  advance_blockers: z.array(z.string()).default([]),
  why_not_engineering_stitching: z.string().default(""),
  summary: z.string().default(""),
});
export type CandidateIdeaReview = z.infer<typeof CandidateIdeaReviewSchema>;

export const MentorChallengeReportSchema = strict({
  evidence_question: z.string().default(""),
  recommended_experiment: z.string().default(""),
  impact_level: ImpactLevelSchema.default("Minor"),
});
export type MentorChallengeReport = z.infer<typeof MentorChallengeReportSchema>;

export const BlueprintArchitectureProposalSchema = strict({
  main_claim: z.string().default(""),
  claim_evidence_map: z.array(ClaimEvidenceEntrySchema).default([]),
  experiment_set: z.array(ExperimentSetEntrySchema).default([]),
  review_notes: z.string().default(""),
});
export type BlueprintArchitectureProposal = z.infer<typeof BlueprintArchitectureProposalSchema>;

export const BaselineReviewReportSchema = strict({
  baseline_strength: z.string().default(""),
  fairness_risks: z.array(z.string()).default([]),
  recommendations: z.array(z.string()).default([]),
});
export type BaselineReviewReport = z.infer<typeof BaselineReviewReportSchema>;

export const MetricReviewReportSchema = strict({
  metric_validity: z.string().default(""),
  metric_risks: z.array(z.string()).default([]),
  recommendations: z.array(z.string()).default([]),
});
export type MetricReviewReport = z.infer<typeof MetricReviewReportSchema>;

export const ConvergenceCheckItemSchema = strict({
  id: z.string(),
  layer: z.enum(["L", "A", "F", "E"]),
  label: z.string(),
  satisfied: z.boolean(),
  detail: z.string().default(""),
});
export type ConvergenceCheckItem = z.infer<typeof ConvergenceCheckItemSchema>;

export const PlanConvergenceStatusSchema = strict({
  thread_id: z.string(),
  lifecycle_state: LifecycleStateSchema,
  current_mode: WorkflowModeSchema,
  idea_version: z.number().int(),
  can_enter_candidate_review: z.boolean(),
  can_advance: z.boolean(),
  can_freeze: z.boolean(),
  can_enter_experiment_design: z.boolean(),
  checks: z.array(ConvergenceCheckItemSchema).default([]),
});
export type PlanConvergenceStatus = z.infer<typeof PlanConvergenceStatusSchema>;

export const ThreadPapersResponseSchema = strict({
  thread_id: z.string(),
  evidence: z.array(
    strict({
      artifact_id: z.string(),
      query: z.string(),
      result_count: z.number().int(),
      created_at: z.string(),
    }),
  ).default([]),
  manifest_entries: z.array(PaperManifestEntrySchema).default([]),
  mini_reviews: z.array(
    strict({
      artifact_id: z.string(),
      title: z.string(),
      status: PublicationStatusSchema,
      created_at: z.string(),
    }),
  ).default([]),
});
export type ThreadPapersResponse = z.infer<typeof ThreadPapersResponseSchema>;

export const SearchBudgetStateSchema = strict({
  run_id: z.string(),
  paper_search_calls: z.number().int().default(0),
  unique_paper_count: z.number().int().default(0),
  budget_exhausted: z.boolean().default(false),
});
export type SearchBudgetState = z.infer<typeof SearchBudgetStateSchema>;

export const ExtendedResearchIdeaPlanDraftSchema = strict({
  artifact_id: z.string(),
  title: z.string(),
  source_run_id: z.string(),
  diagnosis: DiagnosisSchema,
  body: ResearchIdeaPlanBodySchema.default({
    main_claim: "",
    mechanism_sketch: "",
    why_non_trivial: "",
    why_not_engineering_stitching: "",
    falsification_condition: "",
    closest_related_work: [],
    feasibility: {
      compute: "",
      data: "",
      annotation: "",
      timeline: "",
      low_compute_validation: "",
      ideal_extended_validation: "",
    },
    compute_profile: "",
    data_profile: "",
    target_standard: "AI/ML top-tier conference",
    ethics: "",
    reproducibility: "",
    assumptions: {user_confirmed: [], agent_inferred: [], to_verify: []},
  }),
  context_id: z.string(),
  markdown_path: z.string(),
  metadata_path: z.string(),
  created_at: z.string(),
});
export type ExtendedResearchIdeaPlanDraft = z.infer<typeof ExtendedResearchIdeaPlanDraftSchema>;

export const ExtendedResearchIdeaPlanSchema = strict({
  plan_id: z.string(),
  artifact_id: z.string(),
  source_draft_artifact_id: z.string(),
  source_run_id: z.string(),
  title: z.string(),
  diagnosis: DiagnosisSchema,
  body: ResearchIdeaPlanBodySchema,
  context_id: z.string(),
  markdown_path: z.string(),
  metadata_path: z.string(),
  status: z.literal("frozen"),
  frozen_at: z.string(),
  created_at: z.string(),
});
export type ExtendedResearchIdeaPlan = z.infer<typeof ExtendedResearchIdeaPlanSchema>;
