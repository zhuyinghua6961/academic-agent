import fs from "node:fs";
import path from "node:path";

import {
  PaperManifestEntrySchema,
  utcNow,
  newId,
  type PaperManifestEntry,
} from "@academic-agent/schemas";
import type {ProjectWorkspace} from "@academic-agent/workspace";

function manifestPath(workspace: ProjectWorkspace, libraryDir?: string): string {
  const base = libraryDir ?? path.join(workspace.workspaceDir, "papers");
  fs.mkdirSync(base, {recursive: true});
  return path.join(base, "manifest.json");
}

export function readPaperManifest(
  workspace: ProjectWorkspace,
  libraryDir?: string,
): PaperManifestEntry[] {
  const file = manifestPath(workspace, libraryDir);
  if (!fs.existsSync(file)) {
    return [];
  }
  const payload: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  const entries = (payload as {entries?: unknown[]}).entries ?? [];
  return entries.map((entry) => PaperManifestEntrySchema.parse(entry));
}

export function writePaperManifest(
  workspace: ProjectWorkspace,
  entries: PaperManifestEntry[],
  libraryDir?: string,
): void {
  const file = manifestPath(workspace, libraryDir);
  fs.writeFileSync(file, JSON.stringify({entries}, null, 2) + "\n", "utf8");
}

export function registerLocalPaper(
  workspace: ProjectWorkspace,
  localPath: string,
  options: {
    title?: string;
    doi?: string | null;
    arxiv_id?: string | null;
    notes?: string;
    libraryDir?: string;
  } = {},
): PaperManifestEntry {
  const resolved = path.resolve(localPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Paper file not found: ${resolved}`);
  }
  const now = utcNow();
  const entries = readPaperManifest(workspace, options.libraryDir);
  const entry: PaperManifestEntry = {
    paper_id: newId("paper"),
    local_path: resolved,
    title: options.title ?? path.basename(resolved),
    doi: options.doi ?? null,
    arxiv_id: options.arxiv_id ?? null,
    notes: options.notes ?? "",
    ingest_status: "ready",
    publication_status: "unknown",
    linked_evidence_ids: [],
    human_read: false,
    created_at: now,
    updated_at: now,
  };
  entries.push(PaperManifestEntrySchema.parse(entry));
  writePaperManifest(workspace, entries, options.libraryDir);
  return entry;
}

export function linkEvidenceToPaper(
  workspace: ProjectWorkspace,
  paperId: string,
  evidenceId: string,
  libraryDir?: string,
): PaperManifestEntry {
  const entries = readPaperManifest(workspace, libraryDir);
  const index = entries.findIndex((e) => e.paper_id === paperId);
  if (index < 0) {
    throw new Error(`Unknown paper_id: ${paperId}`);
  }
  const linked = new Set(entries[index].linked_evidence_ids);
  linked.add(evidenceId);
  entries[index] = {
    ...entries[index],
    linked_evidence_ids: [...linked],
    updated_at: utcNow(),
  };
  writePaperManifest(workspace, entries, libraryDir);
  return entries[index];
}

export function findManifestEntryByPaperId(
  workspace: ProjectWorkspace,
  paperId: string,
  libraryDir?: string,
): PaperManifestEntry | null {
  return readPaperManifest(workspace, libraryDir).find((e) => e.paper_id === paperId) ?? null;
}

export function markPaperHumanRead(
  workspace: ProjectWorkspace,
  paperId: string,
  libraryDir?: string,
): PaperManifestEntry {
  const entries = readPaperManifest(workspace, libraryDir);
  const index = entries.findIndex((e) => e.paper_id === paperId);
  if (index < 0) {
    throw new Error(`Unknown paper_id: ${paperId}`);
  }
  entries[index] = {...entries[index], human_read: true, updated_at: utcNow()};
  writePaperManifest(workspace, entries, libraryDir);
  return entries[index];
}

export function countHumanReadPapers(workspace: ProjectWorkspace, libraryDir?: string): number {
  return readPaperManifest(workspace, libraryDir).filter((e) => e.human_read).length;
}
