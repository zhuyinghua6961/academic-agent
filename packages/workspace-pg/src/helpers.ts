type SqlRow = Record<string, unknown>;

export function jsonDump(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

export function jsonLoad(payload: string | null | undefined): Record<string, unknown> {
  if (!payload) {
    return {};
  }
  const loaded: unknown = JSON.parse(payload);
  return typeof loaded === "object" && loaded !== null && !Array.isArray(loaded)
    ? (loaded as Record<string, unknown>)
    : {};
}

export function defaultThreadTitle(threadId: string): string {
  return `Untitled ${threadId.slice(-6)}`;
}

export function sessionStatusFromArtifact(
  artifactType: string | null | undefined,
  artifactStatus: string | null | undefined,
  hasReview = false,
): string {
  if (artifactType === "ResearchIdeaPlan" || artifactStatus === "frozen") {
    return "frozen";
  }
  if (hasReview) {
    return "reviewed";
  }
  if (artifactType === "ResearchIdeaPlanDraft") {
    return "draft";
  }
  return "needs literature";
}

export function str(row: SqlRow, key: string): string {
  return String(row[key]);
}

export function strOrNull(row: SqlRow, key: string): string | null {
  const value = row[key];
  return value == null ? null : String(value);
}

export function int(row: SqlRow, key: string): number {
  return Number(row[key]);
}

export function bool(row: SqlRow, key: string): boolean {
  return Boolean(row[key]);
}

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}
