import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {extractTextFromPath, chunkText} from "@academic-agent/pdf-ingest";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, {recursive: true, force: true});
  }
});

describe("pdf ingest", () => {
  it("extracts text from local txt fixture", () => {
    const root = mkdtempSync(join(tmpdir(), "pdf-ingest-"));
    tempRoots.push(root);
    const file = join(root, "paper.txt");
    writeFileSync(file, "Problem: test\nMechanism: attention\nEvidence: benchmark", "utf8");
    const text = extractTextFromPath(file);
    expect(text).toContain("Mechanism");
    expect(chunkText(text).length).toBeGreaterThan(0);
  });
});
