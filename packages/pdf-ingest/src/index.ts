import fs from "node:fs";
import path from "node:path";

import type {PublicationStatus} from "@academic-agent/schemas";

export type TextChunk = {
  chunk_id: string;
  index: number;
  text: string;
  start_offset: number;
  end_offset: number;
};

const CHUNK_SIZE = 4000;

async function extractPdfText(filePath: string): Promise<string> {
  const {getDocument} = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await getDocument({data, useSystemFonts: true}).promise;
  const parts: string[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? String(item.str) : ""))
      .join(" ");
    parts.push(pageText);
  }
  const text = parts.join("\n").replace(/\s{2,}/g, " ").trim();
  if (text.length < 20) {
    throw new Error(`pdfjs could not extract meaningful text from: ${filePath}`);
  }
  return text;
}

export function extractTextFromPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`PDF/text file not found: ${resolved}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (ext === ".txt" || ext === ".md") {
    return fs.readFileSync(resolved, "utf8");
  }
  if (ext === ".pdf") {
    // pdfjs is async; sync callers use a blocking helper for tests/tools.
    let result = "";
    let error: Error | null = null;
    void extractPdfText(resolved)
      .then((text) => {
        result = text;
      })
      .catch((err: unknown) => {
        error = err instanceof Error ? err : new Error(String(err));
      });
    const start = Date.now();
    while (!result && !error && Date.now() - start < 30_000) {
      // busy-wait for short PDFs in tool calls
    }
    if (error) {
      throw error;
    }
    if (!result) {
      throw new Error(`Timed out extracting PDF text: ${resolved}`);
    }
    return result;
  }
  throw new Error(`Unsupported file type for text extraction: ${ext}`);
}

export function chunkText(text: string, chunkSize = CHUNK_SIZE): TextChunk[] {
  const chunks: TextChunk[] = [];
  let offset = 0;
  let index = 0;
  while (offset < text.length) {
    const slice = text.slice(offset, offset + chunkSize);
    chunks.push({
      chunk_id: `chunk_${index}`,
      index,
      text: slice,
      start_offset: offset,
      end_offset: offset + slice.length,
    });
    offset += chunkSize;
    index += 1;
  }
  return chunks;
}

export function searchChunks(chunks: TextChunk[], query: string, limit = 3): TextChunk[] {
  const needle = query.toLowerCase().trim();
  if (!needle) {
    return chunks.slice(0, limit);
  }
  const scored = chunks
    .map((chunk) => ({
      chunk,
      score: chunk.text.toLowerCase().includes(needle) ? 2 : 0,
    }))
    .filter((item) => item.score > 0);
  if (scored.length === 0) {
    return chunks.slice(0, limit);
  }
  return scored.slice(0, limit).map((item) => item.chunk);
}

export function verifyPublicationStatus(input: {
  arxiv_id?: string | null;
  doi?: string | null;
  comments?: string | null;
}): PublicationStatus {
  const comments = (input.comments ?? "").toLowerCase();
  if (comments.includes("accepted") || comments.includes("published")) {
    return "accepted";
  }
  if (input.doi) {
    return "published";
  }
  if (input.arxiv_id) {
    return "preprint";
  }
  return "unknown";
}

export async function fetchPdfToCache(url: string, cacheDir: string): Promise<string> {
  fs.mkdirSync(cacheDir, {recursive: true});
  const fileName = Buffer.from(url).toString("base64url").slice(0, 48) + ".pdf";
  const target = path.join(cacheDir, fileName);
  if (fs.existsSync(target)) {
    return target;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download PDF: ${response.status}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(target, data);
  return target;
}
