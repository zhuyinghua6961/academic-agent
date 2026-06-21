import path from "node:path";

import {
  chunkText,
  extractTextFromPath,
  searchChunks,
} from "@academic-agent/pdf-ingest";
import {
  findManifestEntryByPaperId,
  markPaperHumanRead,
  registerLocalPaper,
  writeDisagreementLog,
  writeInnovationHook,
  writePaperMiniReview,
} from "@academic-agent/harness";
import type {ArtifactManager} from "@academic-agent/harness";
import {recordedProviderEnabled} from "@academic-agent/providers";
import {getDefaultTools, type ToolExecutor, ToolRegistry} from "@academic-agent/search";
import {
  ClosestWorkEntrySchema,
  ExperimentBlueprintBodySchema,
  PublicationStatusSchema,
  ResearchIdeaPlanBodySchema,
  type ClosestWorkEntry,
  type ExperimentBlueprintBody,
  type ResearchIdeaPlanBody,
} from "@academic-agent/schemas";
import type {ProjectWorkspace} from "@academic-agent/workspace";

import {verifyPublicationStatusLive} from "./publication-verify.js";

export type PlanToolContext = {
  workspace: ProjectWorkspace;
  artifactManager: ArtifactManager;
  runId: string;
  threadId: string;
  getPlanBody: () => ResearchIdeaPlanBody;
  setPlanBody: (body: ResearchIdeaPlanBody) => void;
  humanReadPapers: Set<string>;
};

function stubPaperSearch(): ToolExecutor {
  return {
    definition: {
      name: "paper_search",
      description: "Search academic papers (recorded test stub).",
      parameters: {
        type: "object",
        properties: {
          query: {type: "string"},
          max_results: {type: "integer"},
        },
        required: ["query"],
      },
    },
    async execute(args) {
      const query = String(args.query ?? "");
      const max = Number(args.max_results ?? 10);
      const retrievedAt = new Date().toISOString();
      const results = Array.from({length: Math.min(max, 10)}, (_, i) => ({
        title: `${query} related paper ${i + 1}`,
        url: `https://arxiv.org/abs/2401.${String(i).padStart(5, "0")}`,
        source: "arxiv" as const,
        snippet: `Stub result for ${query}`,
        retrieved_at: retrievedAt,
        publication_status: "preprint" as const,
        venue: "arXiv",
      }));
      return {query, source: "paper_search", results, retrieved_at: retrievedAt};
    },
  };
}

export function createPlanArtifactTools(ctx: PlanToolContext): ToolExecutor[] {
  const updatePlanBody: ToolExecutor = {
    definition: {
      name: "update_plan_body",
      description: "Merge JSON fragments into the current ResearchIdeaPlan draft body.",
      parameters: {
        type: "object",
        properties: {
          body_patch: {type: "object", description: "Partial ResearchIdeaPlanBody fields."},
        },
        required: ["body_patch"],
      },
    },
    async execute(args) {
      const patch = (args.body_patch ?? {}) as Record<string, unknown>;
      const merged = ResearchIdeaPlanBodySchema.parse({
        ...ctx.getPlanBody(),
        ...patch,
        feasibility: {
          ...ctx.getPlanBody().feasibility,
          ...(patch.feasibility as Record<string, string> | undefined),
        },
        assumptions: {
          ...ctx.getPlanBody().assumptions,
          ...(patch.assumptions as Record<string, string[]> | undefined),
        },
      });
      ctx.setPlanBody(merged);
      return {updated: true, main_claim: merged.main_claim};
    },
  };

  const recordMiniReview: ToolExecutor = {
    definition: {
      name: "record_mini_review",
      description: "Write a PaperMiniReview artifact for a key paper.",
      parameters: {
        type: "object",
        properties: {
          title: {type: "string"},
          paper_id: {type: "string"},
          status: {type: "string", enum: ["preprint", "accepted", "published", "unknown"]},
          summary: {type: "string"},
          strengths: {type: "array", items: {type: "string"}},
          weaknesses: {type: "array", items: {type: "string"}},
          novelty_risk_for_idea: {type: "string"},
        },
        required: ["title", "summary"],
      },
    },
    async execute(args) {
      const status = PublicationStatusSchema.parse(String(args.status ?? "unknown"));
      const [artifact, review] = writePaperMiniReview(ctx.artifactManager, ctx.runId, {
        source_run_id: ctx.runId,
        paper_id: args.paper_id ? String(args.paper_id) : null,
        title: String(args.title),
        status,
        summary: String(args.summary ?? ""),
        strengths: Array.isArray(args.strengths) ? args.strengths.map(String) : [],
        weaknesses: Array.isArray(args.weaknesses) ? args.weaknesses.map(String) : [],
        questions: [],
        confidence: "medium",
        innovation_hooks: [],
        novelty_risk_for_idea: String(args.novelty_risk_for_idea ?? ""),
      });
      return {artifact_id: artifact.artifact_id, review_id: review.review_id};
    },
  };

  const extractHooks: ToolExecutor = {
    definition: {
      name: "extract_innovation_hooks",
      description: "Extract one or more InnovationHook candidates.",
      parameters: {
        type: "object",
        properties: {
          hooks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                trigger_paper: {type: "string"},
                unsolved_problem: {type: "string"},
                candidate_mechanism: {type: "string"},
                why_non_trivial: {type: "string"},
                validation_path: {type: "string"},
                novelty_risk: {type: "string"},
              },
            },
          },
        },
        required: ["hooks"],
      },
    },
    async execute(args) {
      const hooks = Array.isArray(args.hooks) ? args.hooks : [];
      const ids: string[] = [];
      for (const raw of hooks) {
        if (!raw || typeof raw !== "object") continue;
        const item = raw as Record<string, unknown>;
        const [, hook] = writeInnovationHook(ctx.artifactManager, ctx.runId, {
          source_run_id: ctx.runId,
          trigger_paper: String(item.trigger_paper ?? ""),
          unsolved_problem: String(item.unsolved_problem ?? ""),
          candidate_mechanism: String(item.candidate_mechanism ?? ""),
          why_non_trivial: String(item.why_non_trivial ?? ""),
          validation_path: String(item.validation_path ?? ""),
          novelty_risk: String(item.novelty_risk ?? ""),
          human_feedback: "",
        });
        ids.push(hook.hook_id);
      }
      return {hook_ids: ids, count: ids.length};
    },
  };

  const logDisagreement: ToolExecutor = {
    definition: {
      name: "log_disagreement",
      description: "Persist a DisagreementLog when user and agent positions diverge.",
      parameters: {
        type: "object",
        properties: {
          topic: {type: "string"},
          user_position: {type: "string"},
          agent_position: {type: "string"},
          verification_task: {type: "string"},
          impact_on_idea_version: {type: "string", enum: ["None", "Minor", "Major", "Fatal"]},
        },
        required: ["topic", "user_position", "agent_position"],
      },
    },
    async execute(args) {
      const [, log] = writeDisagreementLog(ctx.artifactManager, ctx.runId, {
        source_run_id: ctx.runId,
        topic: String(args.topic),
        user_position: String(args.user_position),
        agent_position: String(args.agent_position),
        verification_task: String(args.verification_task ?? ""),
        impact_on_idea_version: (args.impact_on_idea_version as "None" | "Minor" | "Major" | "Fatal") ?? "Minor",
        status: "open",
        evidence_for_user: [],
        evidence_for_agent: [],
        current_resolution: "",
      });
      return {log_id: log.log_id, artifact_id: log.artifact_id};
    },
  };

  const updateMatrix: ToolExecutor = {
    definition: {
      name: "update_closest_work_matrix",
      description: "Merge rows into closest_related_work table in plan body.",
      parameters: {
        type: "object",
        properties: {
          entries: {type: "array", items: {type: "object"}},
        },
        required: ["entries"],
      },
    },
    async execute(args) {
      const body = ctx.getPlanBody();
      const incoming = Array.isArray(args.entries) ? args.entries : [];
      const parsed: ClosestWorkEntry[] = incoming.map((e) => ClosestWorkEntrySchema.parse(e));
      const byTitle = new Map(body.closest_related_work.map((r) => [r.title.toLowerCase(), r]));
      for (const row of parsed) {
        byTitle.set(row.title.toLowerCase(), row);
      }
      body.closest_related_work = [...byTitle.values()];
      ctx.setPlanBody(body);
      return {row_count: body.closest_related_work.length};
    },
  };

  const aggregateHooks: ToolExecutor = {
    definition: {
      name: "aggregate_hook_candidates",
      description: "Select top innovation hook candidates and write summary into plan body assumptions.",
      parameters: {
        type: "object",
        properties: {
          candidate_hook_ids: {type: "array", items: {type: "string"}},
          selected_summary: {type: "string"},
        },
        required: ["selected_summary"],
      },
    },
    async execute(args) {
      const body = ctx.getPlanBody();
      const summary = String(args.selected_summary ?? "");
      body.assumptions.agent_inferred = [
        ...new Set([...body.assumptions.agent_inferred, summary]),
      ].slice(0, 12);
      ctx.setPlanBody(body);
      return {
        aggregated: true,
        candidate_count: Array.isArray(args.candidate_hook_ids)
          ? args.candidate_hook_ids.length
          : 0,
      };
    },
  };

  const markHumanRead: ToolExecutor = {
    definition: {
      name: "mark_paper_human_read",
      description: "Mark a paper as human-read for L4 convergence alternative path.",
      parameters: {
        type: "object",
        properties: {paper_id: {type: "string"}, title: {type: "string"}},
        required: ["paper_id"],
      },
    },
    async execute(args) {
      const paperId = String(args.paper_id);
      markPaperHumanRead(ctx.workspace, paperId);
      ctx.humanReadPapers.add(paperId);
      return {paper_id: paperId, marked: true};
    },
  };

  const verifyPublication: ToolExecutor = {
    definition: {
      name: "verify_publication_status",
      description: "Verify publication status via arXiv/OpenAlex metadata.",
      parameters: {
        type: "object",
        properties: {
          arxiv_id: {type: "string"},
          doi: {type: "string"},
          title: {type: "string"},
          comments: {type: "string"},
        },
      },
    },
    async execute(args) {
      const result = await verifyPublicationStatusLive({
        arxiv_id: args.arxiv_id ? String(args.arxiv_id) : null,
        doi: args.doi ? String(args.doi) : null,
        title: args.title ? String(args.title) : null,
        comments: args.comments ? String(args.comments) : null,
      });
      return result;
    },
  };

  return [
    updatePlanBody,
    recordMiniReview,
    extractHooks,
    aggregateHooks,
    logDisagreement,
    updateMatrix,
    markHumanRead,
    verifyPublication,
  ];
}

export function createPaperReadingTools(workspace: ProjectWorkspace): ToolExecutor[] {
  const registerLocalPaperTool: ToolExecutor = {
    definition: {
      name: "register_local_paper",
      description:
        "Register a user-provided local PDF or text file path into the paper library manifest.",
      parameters: {
        type: "object",
        properties: {
          local_path: {type: "string", description: "Absolute or relative path to the PDF/text file."},
          title: {type: "string"},
          doi: {type: "string"},
          arxiv_id: {type: "string"},
          notes: {type: "string"},
        },
        required: ["local_path"],
      },
    },
    async execute(args) {
      const localPath = String(args.local_path ?? "");
      const resolved = path.isAbsolute(localPath)
        ? localPath
        : path.join(workspace.projectRoot, localPath);
      const entry = registerLocalPaper(workspace, resolved, {
        title: args.title ? String(args.title) : undefined,
        doi: args.doi ? String(args.doi) : null,
        arxiv_id: args.arxiv_id ? String(args.arxiv_id) : null,
        notes: args.notes ? String(args.notes) : undefined,
      });
      return {paper_id: entry.paper_id, local_path: entry.local_path, title: entry.title};
    },
  };

  const paperReadSectionTool: ToolExecutor = {
    definition: {
      name: "paper_read_section",
      description: "Read a section/chunk from a registered local paper by paper_id and optional query.",
      parameters: {
        type: "object",
        properties: {
          paper_id: {type: "string"},
          query: {type: "string", description: "Optional keyword to locate relevant chunks."},
          max_chunks: {type: "integer", minimum: 1, maximum: 5},
        },
        required: ["paper_id"],
      },
    },
    async execute(args) {
      const paperId = String(args.paper_id ?? "");
      const entry = findManifestEntryByPaperId(workspace, paperId);
      if (!entry) {
        return {error: `Unknown paper_id: ${paperId}`};
      }
      const text = extractTextFromPath(entry.local_path);
      const chunks = chunkText(text);
      const selected = searchChunks(chunks, String(args.query ?? ""), Number(args.max_chunks ?? 2));
      return {
        paper_id: paperId,
        title: entry.title,
        chunks: selected.map((chunk) => ({
          chunk_id: chunk.chunk_id,
          text: chunk.text.slice(0, 2000),
        })),
      };
    },
  };

  return [registerLocalPaperTool, paperReadSectionTool];
}

export type ExperimentToolContext = {
  runId: string;
  threadId: string;
  getBlueprintBody: () => ExperimentBlueprintBody;
  setBlueprintBody: (body: ExperimentBlueprintBody) => void;
};

export function createExperimentBlueprintTools(ctx: ExperimentToolContext): ToolExecutor[] {
  const updateBlueprintBody: ToolExecutor = {
    definition: {
      name: "update_blueprint_body",
      description: "Merge JSON fragments into the current ExperimentBlueprintDraft body.",
      parameters: {
        type: "object",
        properties: {
          body_patch: {type: "object", description: "Partial ExperimentBlueprintBody fields."},
        },
        required: ["body_patch"],
      },
    },
    async execute(args) {
      const patch = (args.body_patch ?? {}) as Record<string, unknown>;
      const merged = ExperimentBlueprintBodySchema.parse({
        ...ctx.getBlueprintBody(),
        ...patch,
      });
      ctx.setBlueprintBody(merged);
      return {
        updated: true,
        main_claim: merged.main_claim,
        experiment_count: merged.experiment_set.length,
      };
    },
  };
  return [updateBlueprintBody];
}

export function getExperimentTools(
  workspace: ProjectWorkspace,
  expCtx: ExperimentToolContext,
): ToolRegistry {
  const registry = getDefaultTools();
  if (recordedProviderEnabled()) {
    registry.register(stubPaperSearch());
  }
  for (const tool of createExperimentBlueprintTools(expCtx)) {
    registry.register(tool);
  }
  return registry;
}

export function getExtendedTools(
  workspace: ProjectWorkspace,
  planCtx?: PlanToolContext,
): ToolRegistry {
  const registry = getDefaultTools();
  if (recordedProviderEnabled()) {
    registry.register(stubPaperSearch());
  }
  for (const tool of createPaperReadingTools(workspace)) {
    registry.register(tool);
  }
  if (planCtx) {
    for (const tool of createPlanArtifactTools(planCtx)) {
      registry.register(tool);
    }
  }
  return registry;
}
