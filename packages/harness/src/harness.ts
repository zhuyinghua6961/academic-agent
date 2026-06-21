import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { AgentConfig } from "@academic-agent/config";
import {
  AppCacheRecordSchema,
  ConversationSummarySchema,
  PaperSearchEvidenceSchema,
  ProjectMemoryMapSchema,
  ProviderResponseSchema,
  type ExtendedResearchIdeaPlan,
  type ExtendedResearchIdeaPlanDraft,
  newId,
  utcNow,
  type AppCacheRecord,
  type ArtifactMetadata,
  type ConflictRecord,
  type ContextPacket,
  type ConversationSummary,
  type Diagnosis,
  type MemoryRecord,
  type MemorySearchResponse,
  type MemorySearchResult,
  type PaperSearchEvidence,
  type ProjectMemoryMap,
  type ProviderRequest,
  type ProviderResponse,
  type ResearchIdeaPlan,
  type SearchResponse,
  type ThreadSessionSummary,
  type TraceRecord,
} from "@academic-agent/schemas";
import { ProjectWorkspace } from "@academic-agent/workspace";

import { readExtendedDraft, readExtendedPlan, defaultPlanBody } from "./extended-artifacts.js";

const MEMORY_TOKEN_RE = /[\w\u4e00-\u9fff]+/gu;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

function stableJsonStringify(payload: unknown): string {
  return JSON.stringify(sortKeys(payload));
}

export function stableJsonHash(payload: unknown): string {
  return createHash("sha256").update(stableJsonStringify(payload), "utf8").digest("hex");
}

function oneLine(text: string, limit: number): string {
  const cleaned = text.trim().split(/\s+/).join(" ");
  if (cleaned.length <= limit) {
    return cleaned;
  }
  return `${cleaned.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function uniqueRefs(refs: Iterable<unknown>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const ref of refs) {
    const value = String(ref);
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function parseDatetime(value: string): Date | null {
  try {
    const parsed = new Date(value.replace("Z", "+00:00"));
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function timedeltaDays(later: Date, earlier: Date): number {
  const utcLater = Date.UTC(later.getUTCFullYear(), later.getUTCMonth(), later.getUTCDate());
  const utcEarlier = Date.UTC(
    earlier.getUTCFullYear(),
    earlier.getUTCMonth(),
    earlier.getUTCDate(),
  );
  return Math.floor((utcLater - utcEarlier) / (24 * 60 * 60 * 1000));
}

function memoryTokens(text: string): string[] {
  const matches = text.match(MEMORY_TOKEN_RE) ?? [];
  return matches
    .map((token) => token.toLowerCase())
    .filter((token) => token.trim().length > 0);
}

function memoryEmbedding(text: string, dimensions: number): Record<string, number> {
  const dims = Math.max(8, dimensions);
  const vector: Record<string, number> = {};
  for (const token of memoryTokens(text)) {
    const bucket =
      Number.parseInt(createHash("sha256").update(token, "utf8").digest("hex").slice(0, 8), 16) %
      dims;
    const key = String(bucket);
    vector[key] = (vector[key] ?? 0) + 1;
  }
  const norm = Math.sqrt(Object.values(vector).reduce((sum, value) => sum + value * value, 0));
  if (norm <= 0) {
    return {};
  }
  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(vector)) {
    normalized[key] = Number((value / norm).toFixed(8));
  }
  return normalized;
}

function cosine(left: Record<string, number>, right: Record<string, number>): number {
  if (Object.keys(left).length === 0 || Object.keys(right).length === 0) {
    return 0;
  }
  let smaller = left;
  let larger = right;
  if (Object.keys(left).length > Object.keys(right).length) {
    smaller = right;
    larger = left;
  }
  return Object.entries(smaller).reduce(
    (sum, [key, value]) => sum + value * (larger[key] ?? 0),
    0,
  );
}

function keywordOverlap(query: string, text: string): number {
  const queryTokens = new Set(memoryTokens(query));
  if (queryTokens.size === 0) {
    return 0;
  }
  const textTokens = new Set(memoryTokens(text));
  let overlap = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / queryTokens.size;
}

function writeSortedJson(filePath: string, payload: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(sortKeys(payload), null, 2)}\n`, "utf8");
}

export class ContextBuilder {
  build_for_idea(
    idea: string,
    relevant_artifacts: string[] | null = null,
    source_refs: string[] | null = null,
    excluded_context_summary: string | null = null,
  ): ContextPacket {
    const artifact_refs = relevant_artifacts ?? [];
    return {
      context_id: newId("ctx"),
      mode: "idea_plan",
      task: "Diagnose a raw research idea into five top-conference-oriented fields.",
      idea,
      relevant_artifacts: artifact_refs,
      constraints: [
        "v0 uses the configured planner provider and records provider/tool traces.",
        "Do not claim novelty without literature retrieval.",
        "Produce diagnosis only; do not freeze a ResearchIdeaPlan.",
      ],
      source_refs: ["user.idea", ...(source_refs ?? [])],
      excluded_context_summary:
        excluded_context_summary ?? "No prior artifacts or paper memory were retrieved.",
      created_at: utcNow(),
    };
  }
}

export class MemoryManager {
  readonly workspace: ProjectWorkspace;

  constructor(workspace: ProjectWorkspace) {
    this.workspace = workspace;
  }

  _config() {
    return AgentConfig.load(this.workspace.projectRoot).memory;
  }

  ensure_memory_entrypoint(): string {
    this.workspace.init();
    const [memory_map, metadata_path] = this.project_memory_paths();
    if (!fs.existsSync(memory_map) || !fs.existsSync(metadata_path)) {
      this.rebuild_project_memory_map();
    }
    return memory_map;
  }

  project_memory_paths(): [string, string] {
    this.workspace.init();
    const memory_dir = path.join(this.workspace.workspaceDir, "memory");
    fs.mkdirSync(memory_dir, { recursive: true });
    return [
      path.join(memory_dir, "project-memory-map.md"),
      path.join(memory_dir, "project-memory-map.json"),
    ];
  }

  read_project_memory_map(): ProjectMemoryMap {
    const [, metadata_path] = this.project_memory_paths();
    if (!fs.existsSync(metadata_path)) {
      return this.rebuild_project_memory_map();
    }
    const payload: unknown = JSON.parse(fs.readFileSync(metadata_path, "utf8"));
    return ProjectMemoryMapSchema.parse(payload);
  }

  read_project_memory_markdown(): string {
    const [markdown_path, metadata_path] = this.project_memory_paths();
    if (!fs.existsSync(markdown_path) || !fs.existsSync(metadata_path)) {
      this.rebuild_project_memory_map();
    }
    return fs.readFileSync(markdown_path, "utf8");
  }

  rebuild_project_memory_map(thread_limit = 50): ProjectMemoryMap {
    this.workspace.init();
    const artifact_manager = new ArtifactManager(this.workspace);
    const threads = this.workspace.list_thread_sessions(thread_limit);
    for (const thread of threads) {
      this._sync_thread_memory_records(thread.thread_id, artifact_manager);
    }
    const stale_count = this.recheck_stale_records();
    this.detect_conflicts();
    if (stale_count > 0) {
      this._upsert_memory_record({
        record_id: this._record_id("stale_recheck", this.workspace.projectId),
        thread_id: null,
        record_type: "stale_recheck",
        title: "Stale memory recheck",
        summary: `Marked ${stale_count} memory records as stale during rebuild.`,
        source_refs: ["memory.recheck"],
        artifact_refs: [],
        status: "active",
        importance: 2,
        created_at: utcNow(),
        updated_at: utcNow(),
      });
    }

    const records = this.workspace.list_memory_records(undefined, undefined, 200);
    const [markdown_path, metadata_path] = this.project_memory_paths();
    const updated_at = utcNow();
    const memory_map: ProjectMemoryMap = {
      project_id: this.workspace.projectId,
      markdown_path,
      metadata_path,
      updated_at,
      thread_count: threads.length,
      record_count: records.length,
      source_refs: uniqueRefs(records.flatMap((record) => record.source_refs)),
      records,
    };
    fs.writeFileSync(
      markdown_path,
      this._render_project_memory_map(memory_map, threads),
      "utf8",
    );
    writeSortedJson(metadata_path, memory_map);
    return memory_map;
  }

  search_memory(
    query: string,
    thread_id: string | null = null,
    limit: number | null = null,
  ): MemorySearchResponse {
    const config = this._config();
    const requested_limit = limit ?? config.retrieval_limit;
    let records = this.workspace.list_memory_records(undefined, undefined, 300);
    if (records.length === 0) {
      this.rebuild_project_memory_map();
      records = this.workspace.list_memory_records(undefined, undefined, 300);
    }
    const index = this.workspace.list_memory_index();
    const query_embedding = memoryEmbedding(query, config.vector_dimensions);
    const scored: MemorySearchResult[] = [];
    for (const record of records) {
      if (thread_id !== null && record.thread_id !== thread_id && record.thread_id !== null) {
        continue;
      }
      const search_text = this._record_search_text(record);
      const indexed = index[record.record_id];
      let embedding: Record<string, number>;
      if (indexed) {
        const rawEmbedding = indexed.embedding;
        embedding = {};
        if (rawEmbedding && typeof rawEmbedding === "object" && !Array.isArray(rawEmbedding)) {
          for (const [key, value] of Object.entries(rawEmbedding as Record<string, unknown>)) {
            embedding[String(key)] = Number(value);
          }
        }
      } else {
        embedding = memoryEmbedding(search_text, config.vector_dimensions);
      }
      if (!indexed) {
        this.workspace.upsert_memory_index(
          record.record_id,
          search_text,
          embedding,
          stableJsonHash(search_text),
        );
      }
      const vector_score = cosine(query_embedding, embedding);
      const keyword_score = keywordOverlap(query, search_text);
      const importance_score = record.importance / 5;
      const thread_bonus = thread_id !== null && record.thread_id === thread_id ? 1 : 0;
      const stale_penalty = record.status === "stale" ? 0.2 : 0;
      const conflict_bonus = record.status === "conflict" ? 0.05 : 0;
      const score =
        0.55 * vector_score +
        0.3 * keyword_score +
        0.1 * importance_score +
        0.05 * thread_bonus +
        conflict_bonus -
        stale_penalty;
      if (score <= 0) {
        continue;
      }
      scored.push({
        record,
        score: Number(score.toFixed(6)),
        vector_score: Number(vector_score.toFixed(6)),
        keyword_score: Number(keyword_score.toFixed(6)),
        reason: this._search_reason(record, vector_score, keyword_score),
      });
    }
    scored.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.record.importance !== left.record.importance) {
        return right.record.importance - left.record.importance;
      }
      return left.record.updated_at.localeCompare(right.record.updated_at);
    });
    return {
      query,
      thread_id,
      results: scored.slice(0, requested_limit),
    };
  }

  recheck_stale_records(): number {
    const config = this._config();
    if (!config.stale_recheck_enabled) {
      return 0;
    }
    const ttl_days = Math.max(1, config.paper_evidence_ttl_days);
    const now = new Date();
    let stale_count = 0;
    for (const record of this.workspace.list_memory_records(undefined, "paper_evidence", 500)) {
      const updated_at = parseDatetime(record.updated_at);
      if (updated_at === null) {
        continue;
      }
      if (timedeltaDays(now, updated_at) < ttl_days) {
        continue;
      }
      if (record.status !== "stale") {
        this.workspace.update_memory_record_status(record.record_id, "stale");
        stale_count += 1;
      }
    }
    return stale_count;
  }

  detect_conflicts(): ConflictRecord[] {
    const config = this._config();
    if (!config.conflict_detection_enabled) {
      return [];
    }
    const conflicts: ConflictRecord[] = [];
    const now = utcNow();
    for (const thread of this.workspace.list_thread_sessions(200)) {
      const reviews = this.workspace.list_idea_reviews(thread.thread_id);
      const decisions = new Set(reviews.map((review) => String(review.decision)));
      if (decisions.size > 1) {
        const conflict: ConflictRecord = {
          conflict_id: this._record_id("conflict.review", thread.thread_id),
          thread_id: thread.thread_id,
          conflict_type: "review_decision_conflict",
          status: "open",
          summary:
            "This thread has multiple idea review decisions: " +
            `${[...decisions].sort().join(", ")}. Treat the latest decision as ` +
            "active but inspect the older review before freezing.",
          record_refs: reviews
            .slice(0, 5)
            .map((review) => this._record_id("idea_review", String(review.review_id))),
          source_refs: reviews.slice(0, 5).map((review) => `review:${review.review_id}`),
          created_at: now,
          updated_at: now,
        };
        this.workspace.upsert_conflict_record(conflict);
        conflicts.push(conflict);
      }

      const latest_review = reviews[0] ?? null;
      const plan_artifact = this.workspace.latest_plan_artifact_for_thread(thread.thread_id);
      if (
        latest_review !== null &&
        plan_artifact !== null &&
        plan_artifact.artifact_type === "ResearchIdeaPlan" &&
        String(latest_review.decision) !== "Advance"
      ) {
        const conflict: ConflictRecord = {
          conflict_id: this._record_id("conflict.freeze_gate", thread.thread_id),
          thread_id: thread.thread_id,
          conflict_type: "freeze_gate_conflict",
          status: "open",
          summary:
            "A ResearchIdeaPlan is frozen while the latest idea review decision " +
            `is ${String(latest_review.decision)}, not Advance.`,
          record_refs: [
            this._record_id("current_plan", thread.thread_id),
            this._record_id("idea_review", String(latest_review.review_id)),
          ],
          source_refs: [
            `artifact:${plan_artifact.artifact_id}`,
            `review:${latest_review.review_id}`,
          ],
          created_at: now,
          updated_at: now,
        };
        this.workspace.upsert_conflict_record(conflict);
        conflicts.push(conflict);
      }

      const stale_evidence = this.workspace
        .list_memory_records(thread.thread_id, "paper_evidence", 50)
        .filter((record) => record.status === "stale");
      if (stale_evidence.length > 0) {
        const conflict: ConflictRecord = {
          conflict_id: this._record_id("conflict.stale_evidence", thread.thread_id),
          thread_id: thread.thread_id,
          conflict_type: "stale_evidence_conflict",
          status: "open",
          summary:
            `${stale_evidence.length} paper evidence records are stale. ` +
            "Re-run search before making novelty or latest-paper claims.",
          record_refs: stale_evidence.slice(0, 10).map((record) => record.record_id),
          source_refs: stale_evidence
            .slice(0, 10)
            .flatMap((record) => record.source_refs.slice(0, 3)),
          created_at: now,
          updated_at: now,
        };
        this.workspace.upsert_conflict_record(conflict);
        conflicts.push(conflict);
      }
    }
    return conflicts;
  }

  _upsert_memory_record(record: MemoryRecord): void {
    this.workspace.upsert_memory_record(record);
    const search_text = this._record_search_text(record);
    const config = this._config();
    this.workspace.upsert_memory_index(
      record.record_id,
      search_text,
      memoryEmbedding(search_text, config.vector_dimensions),
      stableJsonHash(search_text),
      record.updated_at,
    );
  }

  _record_search_text(record: MemoryRecord): string {
    return [
      record.title,
      record.summary,
      record.record_type,
      record.status,
      record.source_refs.join(" "),
      record.artifact_refs.join(" "),
    ].join("\n");
  }

  _search_reason(record: MemoryRecord, vector_score: number, keyword_score: number): string {
    const reasons: string[] = [record.record_type];
    if (vector_score > 0.15) {
      reasons.push("vector similarity");
    }
    if (keyword_score > 0) {
      reasons.push("keyword overlap");
    }
    if (record.status !== "active") {
      reasons.push(`status=${record.status}`);
    }
    return reasons.join(", ");
  }

  _sync_thread_memory_records(thread_id: string, artifact_manager: ArtifactManager): void {
    const now = utcNow();
    const plan_artifact = this.workspace.latest_plan_artifact_for_thread(thread_id);
    if (plan_artifact !== null) {
      try {
        let diagnosis: Diagnosis;
        let status: string;
        if (plan_artifact.artifact_type === "ResearchIdeaPlan") {
          const [, plan] = artifact_manager.read_research_idea_plan(plan_artifact.artifact_id);
          diagnosis = plan.diagnosis;
          status = plan.status;
        } else {
          const [, draft] = artifact_manager.read_research_idea_draft(plan_artifact.artifact_id);
          diagnosis = draft.diagnosis;
          status = "draft";
        }
        this._upsert_memory_record({
          record_id: this._record_id("current_plan", thread_id),
          thread_id,
          record_type: "current_plan",
          title: `Current idea plan (${status})`,
          summary: [
            `Problem: ${oneLine(diagnosis.problem, 260)}`,
            `Gap: ${oneLine(diagnosis.gap, 260)}`,
            `Candidate Mechanism: ${oneLine(diagnosis.candidate_mechanism, 260)}`,
            `Main Uncertainty: ${oneLine(diagnosis.main_uncertainty, 260)}`,
          ].join("\n"),
          source_refs: [`artifact:${plan_artifact.artifact_id}`],
          artifact_refs: [plan_artifact.artifact_id],
          status: "active",
          importance: 5,
          created_at: now,
          updated_at: now,
        });
      } catch (exc) {
        this._upsert_memory_record({
          record_id: this._record_id("current_plan", thread_id),
          thread_id,
          record_type: "current_plan",
          title: "Current idea plan read error",
          summary: oneLine(String(exc), 400),
          source_refs: [`artifact:${plan_artifact.artifact_id}`],
          artifact_refs: [plan_artifact.artifact_id],
          status: "conflict",
          importance: 5,
          created_at: now,
          updated_at: now,
        });
      }
    }

    const review = this.workspace.latest_idea_review(thread_id);
    if (review !== null) {
      this._upsert_memory_record({
        record_id: this._record_id("idea_review", String(review.review_id)),
        thread_id,
        record_type: "idea_review",
        title: `Idea review: ${String(review.decision)}`,
        summary: oneLine(String(review.notes ?? "No notes."), 600),
        source_refs: [
          `review:${String(review.review_id)}`,
          `artifact:${String(review.artifact_id)}`,
        ],
        artifact_refs: [String(review.artifact_id)],
        status: "active",
        importance: 4,
        created_at: String(review.created_at),
        updated_at: now,
      });
    }

    for (const artifact of this.workspace.latest_artifacts_for_thread(
      thread_id,
      "PaperSearchEvidence",
      5,
    )) {
      let retrieved_at = artifact.created_at;
      let summary: string;
      try {
        const [, evidence] = artifact_manager.read_paper_search_evidence(artifact.artifact_id);
        const response = evidence.search_response;
        retrieved_at = response.retrieved_at;
        const titles = response.results
          .slice(0, 5)
          .map((result) => result.title)
          .filter((title): title is string => Boolean(title))
          .map((title) => oneLine(title, 140));
        summary = [
          `Query: ${oneLine(evidence.query, 220)}`,
          `Source: ${response.source}; results: ${response.results.length}; retrieved_at: ${response.retrieved_at}`,
          `Top titles: ${titles.length > 0 ? titles.join(" | ") : "None"}`,
        ].join("\n");
        if (response.error) {
          summary += `\nError: ${oneLine(response.error, 260)}`;
        }
      } catch (exc) {
        retrieved_at = artifact.created_at;
        summary = `Paper evidence read error: ${oneLine(String(exc), 400)}`;
      }
      this._upsert_memory_record({
        record_id: this._record_id("paper_evidence", artifact.artifact_id),
        thread_id,
        record_type: "paper_evidence",
        title: artifact.title,
        summary,
        source_refs: [`paper_evidence:${artifact.artifact_id}`],
        artifact_refs: [artifact.artifact_id],
        status: "active",
        importance: 3,
        created_at: artifact.created_at,
        updated_at: retrieved_at,
      });
    }

    const summary = this.read_conversation_summary(thread_id);
    if (summary !== null) {
      this._upsert_memory_record({
        record_id: this._record_id("conversation_summary", thread_id),
        thread_id,
        record_type: "conversation_summary",
        title: "Conversation summary",
        summary: oneLine(summary.summary_text, 900),
        source_refs: summary.source_refs,
        artifact_refs: [],
        status: "active",
        importance: 3,
        created_at: summary.created_at,
        updated_at: summary.updated_at,
      });
    }
  }

  _record_id(record_type: string, source: string): string {
    const digest = stableJsonHash({ record_type, source }).slice(0, 24);
    return `memory_${digest}`;
  }

  _render_project_memory_map(
    memory_map: ProjectMemoryMap,
    threads: ThreadSessionSummary[],
  ): string {
    const lines = [
      "# Project Memory Map",
      "",
      "This file is a generated navigation layer for Academic Agent memory. " +
        "It points to artifacts, summaries, reviews, traces, and paper-search evidence; " +
        "it does not replace the full local transcript.",
      "",
      `- Project: \`${memory_map.project_id}\``,
      `- Updated: \`${memory_map.updated_at}\``,
      `- Threads: \`${memory_map.thread_count}\``,
      `- Memory records: \`${memory_map.record_count}\``,
      "",
      "## Current Research State",
    ];
    const plan_records = memory_map.records.filter(
      (record) => record.record_type === "current_plan",
    );
    if (plan_records.length === 0) {
      lines.push("- No current plan records yet.");
    }
    for (const record of plan_records.slice(0, 10)) {
      const title = this._thread_title(record.thread_id ?? null, threads);
      lines.push(
        `### ${title}`,
        `- Thread: \`${record.thread_id}\``,
        `- Record: \`${record.record_id}\``,
        `- Status: \`${record.status}\`; importance: \`${record.importance}\``,
        `- Artifacts: ${
          record.artifact_refs.length > 0
            ? record.artifact_refs.map((ref) => `\`${ref}\``).join(", ")
            : "`None`"
        }`,
        "",
        record.summary,
        "",
      );
    }

    lines.push("## Important Decisions");
    const review_records = memory_map.records.filter(
      (record) => record.record_type === "idea_review",
    );
    if (review_records.length === 0) {
      lines.push("- No review decisions recorded yet.");
    }
    for (const record of review_records.slice(0, 20)) {
      lines.push(
        `- \`${record.updated_at}\` \`${record.record_id}\` ${record.title}: ` +
          `${oneLine(record.summary, 220)}`,
      );
    }

    lines.push("", "## Where To Look");
    for (const thread of threads.slice(0, 20)) {
      lines.push(
        `- \`${thread.thread_id}\` ${thread.title} ` +
          `(${thread.session_status}, updated \`${thread.updated_at}\`)`,
      );
    }
    const evidence_records = memory_map.records.filter(
      (record) => record.record_type === "paper_evidence",
    );
    if (evidence_records.length > 0) {
      lines.push("", "## Paper Evidence Index");
      for (const record of evidence_records.slice(0, 20)) {
        lines.push(
          `- \`${record.record_id}\` ${record.title}: ${oneLine(record.summary, 220)}`,
        );
      }
    }

    const summary_records = memory_map.records.filter(
      (record) => record.record_type === "conversation_summary",
    );
    if (summary_records.length > 0) {
      lines.push("", "## Conversation Summaries");
      for (const record of summary_records.slice(0, 20)) {
        lines.push(
          `- \`${record.thread_id}\` \`${record.record_id}\`: ${oneLine(record.summary, 220)}`,
        );
      }
    }

    const conflicts = this.workspace.list_conflict_records(undefined, "open", 50);
    lines.push("", "## Conflicts");
    if (conflicts.length === 0) {
      lines.push("- No open conflicts.");
    }
    for (const conflict of conflicts) {
      lines.push(
        `- \`${conflict.conflict_id}\` ${conflict.conflict_type}: ` +
          `${oneLine(conflict.summary, 260)}`,
      );
    }

    lines.push(
      "",
      "## Stale / Needs Recheck",
      "- Venue rules, model capabilities, provider API behavior, paper status, and benchmark SOTA should be rechecked before use.",
    );
    return `${lines.join("\n").trimEnd()}\n`;
  }

  _thread_title(thread_id: string | null, threads: ThreadSessionSummary[]): string {
    if (thread_id === null) {
      return "Project-level memory";
    }
    for (const thread of threads) {
      if (thread.thread_id === thread_id) {
        return thread.title;
      }
    }
    return thread_id;
  }

  conversation_summary_dir(): string {
    this.workspace.init();
    const summary_dir = path.join(this.workspace.workspaceDir, "memory", "conversation-summaries");
    fs.mkdirSync(summary_dir, { recursive: true });
    return summary_dir;
  }

  read_conversation_summary(thread_id: string): ConversationSummary | null {
    const metadata_path = path.join(this.conversation_summary_dir(), `${thread_id}.json`);
    if (!fs.existsSync(metadata_path)) {
      return null;
    }
    const payload: unknown = JSON.parse(fs.readFileSync(metadata_path, "utf8"));
    return ConversationSummarySchema.parse(payload);
  }

  write_conversation_summary(summary: ConversationSummary): ConversationSummary {
    const summary_dir = this.conversation_summary_dir();
    const markdown_path = path.join(summary_dir, `${summary.thread_id}.md`);
    const metadata_path = path.join(summary_dir, `${summary.thread_id}.json`);
    fs.writeFileSync(
      markdown_path,
      [
        "# Conversation Summary",
        "",
        `- Thread: \`${summary.thread_id}\``,
        `- Covered messages: \`${summary.covered_message_count}\``,
        `- Covered until ordinal: \`${summary.covered_until_ordinal}\``,
        `- Summary source: \`${summary.summary_source}\``,
        `- Updated: \`${summary.updated_at}\``,
        "",
        "## Summary",
        summary.summary_text,
        "",
        "## Source Refs",
        ...summary.source_refs.map((ref) => `- \`${ref}\``),
        "",
      ].join("\n"),
      "utf8",
    );
    const normalized: ConversationSummary = {
      ...summary,
      markdown_path,
      metadata_path,
    };
    writeSortedJson(metadata_path, normalized);
    return normalized;
  }
}

export class CacheManager {
  readonly workspace: ProjectWorkspace;

  constructor(workspace: ProjectWorkspace) {
    this.workspace = workspace;
  }

  _cache_key(request: ProviderRequest): string {
    return stableJsonHash({
      cache_type: "provider_response",
      provider: request.provider,
      model: request.model,
      profile: request.profile,
      prompt_version: request.prompt_version,
      input_hash: request.input_hash,
    });
  }

  get_provider_response(request: ProviderRequest): ProviderResponse | null {
    const record = this.workspace.get_app_cache_record(this._cache_key(request));
    if (record === null) {
      return null;
    }
    return ProviderResponseSchema.parse(record.payload_json);
  }

  store_provider_response(request: ProviderRequest, response: ProviderResponse): void {
    const record: AppCacheRecord = {
      cache_key: this._cache_key(request),
      cache_type: "provider_response",
      provider: request.provider,
      model: request.model,
      profile: request.profile,
      prompt_version: request.prompt_version,
      input_hash: request.input_hash,
      payload_json: response,
      created_at: utcNow(),
    };
    AppCacheRecordSchema.parse(record);
    this.workspace.upsert_app_cache_record(record);
  }
}

export class TraceRecorder {
  readonly workspace: ProjectWorkspace;

  constructor(workspace: ProjectWorkspace) {
    this.workspace = workspace;
  }

  record(run_id: string, trace_type: string, payload: Record<string, unknown>): TraceRecord {
    this.workspace.ensure_initialized();
    const trace_id = newId("trace");
    const trace_path = path.join(this.workspace.workspaceDir, "traces", `${trace_id}.json`);
    const created_at = utcNow();
    const serializable: Record<string, unknown> = {
      trace_id,
      run_id,
      trace_type,
      payload,
      created_at,
    };
    writeSortedJson(trace_path, serializable);
    const trace: TraceRecord = {
      trace_id,
      run_id,
      trace_type,
      path: trace_path,
      payload_hash: stableJsonHash(serializable),
      created_at,
    };
    this.workspace.insert_trace(trace);
    return trace;
  }

  read_payload(trace: TraceRecord): Record<string, unknown> {
    const payload: unknown = JSON.parse(fs.readFileSync(trace.path, "utf8"));
    return typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  }
}

export class ArtifactManager {
  readonly workspace: ProjectWorkspace;

  constructor(workspace: ProjectWorkspace) {
    this.workspace = workspace;
  }

  write_research_idea_draft(
    run_id: string,
    diagnosis: Diagnosis,
    context: ContextPacket,
    trace_refs: string[],
    artifact_id: string | null = null,
  ): [ArtifactMetadata, ExtendedResearchIdeaPlanDraft] {
    this.workspace.ensure_initialized();
    const next_artifact_id = artifact_id ?? newId("artifact");
    const title = "ResearchIdeaPlanDraft";
    const markdown_path = path.join(
      this.workspace.workspaceDir,
      "artifacts",
      `${next_artifact_id}.md`,
    );
    const metadata_path = path.join(
      this.workspace.workspaceDir,
      "artifacts",
      `${next_artifact_id}.json`,
    );
    const created_at = utcNow();

    const markdown = this._render_markdown(diagnosis, context);
    fs.writeFileSync(markdown_path, markdown, "utf8");

    const metadata: ArtifactMetadata = {
      artifact_id: next_artifact_id,
      artifact_type: "ResearchIdeaPlanDraft",
      status: "draft",
      title,
      path: markdown_path,
      metadata_path,
      schema_version: "v0",
      source_run_id: run_id,
      trace_refs,
      created_at,
    };
    const draft: ExtendedResearchIdeaPlanDraft = {
      artifact_id: next_artifact_id,
      title,
      source_run_id: run_id,
      diagnosis,
      body: defaultPlanBody(),
      context_id: context.context_id,
      markdown_path,
      metadata_path,
      created_at,
    };
    writeSortedJson(metadata_path, {
      metadata,
      draft,
    });
    this.workspace.insert_artifact(metadata);
    return [metadata, draft];
  }

  read_artifact_content(artifact_id: string): [ArtifactMetadata, string] {
    const metadata = this.workspace.get_artifact_metadata(artifact_id);
    const content = fs.readFileSync(metadata.path, "utf8");
    return [metadata, content];
  }

  read_research_idea_draft(artifact_id: string): [ArtifactMetadata, ExtendedResearchIdeaPlanDraft] {
    return readExtendedDraft(this, artifact_id);
  }

  read_research_idea_plan(artifact_id: string): [ArtifactMetadata, ExtendedResearchIdeaPlan] {
    return readExtendedPlan(this, artifact_id);
  }

  freeze_research_idea_plan(
    source_metadata: ArtifactMetadata,
    draft: ExtendedResearchIdeaPlanDraft,
  ): [ArtifactMetadata, ResearchIdeaPlan] {
    this.workspace.ensure_initialized();
    const frozen_at = utcNow();
    const artifact_id = newId("artifact");
    const markdown_path = path.join(this.workspace.workspaceDir, "artifacts", `${artifact_id}.md`);
    const metadata_path = path.join(this.workspace.workspaceDir, "artifacts", `${artifact_id}.json`);
    const plan: ResearchIdeaPlan = {
      plan_id: newId("plan"),
      artifact_id,
      source_draft_artifact_id: source_metadata.artifact_id,
      source_run_id: draft.source_run_id,
      title: "ResearchIdeaPlan",
      diagnosis: draft.diagnosis,
      body: draft.body,
      context_id: draft.context_id,
      markdown_path,
      metadata_path,
      status: "frozen",
      frozen_at,
      created_at: frozen_at,
    };
    const metadata: ArtifactMetadata = {
      artifact_id,
      artifact_type: "ResearchIdeaPlan",
      status: "frozen",
      title: plan.title,
      path: markdown_path,
      metadata_path,
      schema_version: "v1",
      source_run_id: draft.source_run_id,
      trace_refs: source_metadata.trace_refs ?? [],
      created_at: frozen_at,
    };
    fs.writeFileSync(markdown_path, this._render_frozen_plan_markdown(plan), "utf8");
    writeSortedJson(metadata_path, {
      metadata,
      plan,
    });
    this.workspace.insert_artifact(metadata);
    return [metadata, plan];
  }

  write_paper_search_evidence(
    run_id: string,
    search_response: SearchResponse,
    trace_refs: string[] | null = null,
  ): [ArtifactMetadata, PaperSearchEvidence] {
    this.workspace.ensure_initialized();
    const artifact_id = newId("artifact");
    const markdown_path = path.join(this.workspace.workspaceDir, "artifacts", `${artifact_id}.md`);
    const metadata_path = path.join(this.workspace.workspaceDir, "artifacts", `${artifact_id}.json`);
    const created_at = utcNow();
    const evidence: PaperSearchEvidence = {
      evidence_id: newId("paper_evidence"),
      artifact_id,
      source_run_id: run_id,
      query: search_response.query,
      search_response,
      markdown_path,
      metadata_path,
      created_at,
    };
    const metadata: ArtifactMetadata = {
      artifact_id,
      artifact_type: "PaperSearchEvidence",
      status: "frozen",
      title: `PaperSearchEvidence: ${search_response.query.slice(0, 60)}`,
      path: markdown_path,
      metadata_path,
      schema_version: "v1",
      source_run_id: run_id,
      trace_refs: trace_refs ?? [],
      created_at,
    };
    fs.writeFileSync(markdown_path, this._render_paper_search_markdown(evidence), "utf8");
    writeSortedJson(metadata_path, {
      metadata,
      evidence,
    });
    this.workspace.insert_artifact(metadata);
    return [metadata, evidence];
  }

  read_paper_search_evidence(artifact_id: string): [ArtifactMetadata, PaperSearchEvidence] {
    const metadata = this.workspace.get_artifact_metadata(artifact_id);
    const payload: unknown = JSON.parse(fs.readFileSync(metadata.metadata_path, "utf8"));
    const record = payload as { evidence?: unknown };
    return [metadata, PaperSearchEvidenceSchema.parse(record.evidence)];
  }

  _render_markdown(diagnosis: Diagnosis, context: ContextPacket): string {
    const evidence = diagnosis.evidence_needed.map((item) => `- ${item}`).join("\n");
    const questions =
      diagnosis.clarifying_questions.length > 0
        ? diagnosis.clarifying_questions.map((item) => `- ${item}`).join("\n")
        : "- None";
    return [
      "# ResearchIdeaPlanDraft",
      "",
      `- Context: \`${context.context_id}\``,
      "- Status: `draft`",
      "",
      "## Problem",
      diagnosis.problem,
      "",
      "## Gap",
      diagnosis.gap,
      "",
      "## Candidate Mechanism",
      diagnosis.candidate_mechanism,
      "",
      "## Evidence Needed",
      evidence,
      "",
      "## Main Uncertainty",
      diagnosis.main_uncertainty,
      "",
      "## Clarifying Questions",
      questions,
      "",
    ].join("\n");
  }

  _render_frozen_plan_markdown(plan: ResearchIdeaPlan): string {
    const evidence = plan.diagnosis.evidence_needed.map((item) => `- ${item}`).join("\n");
    const questions =
      plan.diagnosis.clarifying_questions.length > 0
        ? plan.diagnosis.clarifying_questions.map((item) => `- ${item}`).join("\n")
        : "- None";
    return [
      "# ResearchIdeaPlan",
      "",
      `- Status: \`${plan.status}\``,
      `- Frozen at: \`${plan.frozen_at}\``,
      `- Source draft: \`${plan.source_draft_artifact_id}\``,
      `- Source run: \`${plan.source_run_id}\``,
      `- Context: \`${plan.context_id}\``,
      "",
      "## Problem",
      plan.diagnosis.problem,
      "",
      "## Gap",
      plan.diagnosis.gap,
      "",
      "## Candidate Mechanism",
      plan.diagnosis.candidate_mechanism,
      "",
      "## Evidence Needed",
      evidence,
      "",
      "## Main Uncertainty",
      plan.diagnosis.main_uncertainty,
      "",
      "## Clarifying Questions",
      questions,
      "",
    ].join("\n");
  }

  _render_paper_search_markdown(evidence: PaperSearchEvidence): string {
    const response = evidence.search_response;
    const lines = [
      "# PaperSearchEvidence",
      "",
      `- Query: \`${evidence.query}\``,
      `- Source: \`${response.source}\``,
      `- Retrieved at: \`${response.retrieved_at}\``,
      `- Error: \`${response.error ?? "None"}\``,
      "",
      "## Results",
    ];
    if (response.results.length === 0) {
      lines.push("- No results.");
    }
    response.results.forEach((item, index) => {
      const authors =
        item.authors && item.authors.length > 0
          ? item.authors.slice(0, 5).join(", ")
          : "Unknown authors";
      lines.push(
        `### ${index + 1}. ${item.title}`,
        `- Source: \`${item.source}\``,
        `- URL: ${item.url}`,
        `- Authors: ${authors}`,
        `- Published: \`${item.published_at ?? "unknown"}\``,
        "",
        item.snippet ?? "No snippet.",
        "",
      );
    });
    return `${lines.join("\n").trimEnd()}\n`;
  }
}
