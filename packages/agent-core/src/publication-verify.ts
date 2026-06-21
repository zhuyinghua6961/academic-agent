import type {PublicationStatus} from "@academic-agent/schemas";

import {verifyPublicationStatus} from "@academic-agent/pdf-ingest";

type VerifyInput = {
  arxiv_id?: string | null;
  doi?: string | null;
  title?: string | null;
  comments?: string | null;
};

export async function verifyPublicationStatusLive(input: VerifyInput): Promise<{
  publication_status: PublicationStatus;
  source: string;
  venue?: string | null;
}> {
  const heuristic = verifyPublicationStatus({
    arxiv_id: input.arxiv_id,
    doi: input.doi,
    comments: input.comments,
  });
  if (input.doi) {
    try {
      const response = await fetch(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(input.doi)}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) {
        const data = (await response.json()) as {
          type?: string;
          primary_location?: {source?: {display_name?: string}};
        };
        const venue = data.primary_location?.source?.display_name ?? null;
        const status: PublicationStatus =
          data.type === "article" || data.type === "review" ? "published" : heuristic;
        return {publication_status: status, source: "openalex", venue};
      }
    } catch {
      // fall through
    }
  }
  if (input.arxiv_id) {
    try {
      const id = input.arxiv_id.replace(/^arxiv:/i, "");
      const response = await fetch(
        `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`,
        {signal: AbortSignal.timeout(8000)},
      );
      if (response.ok) {
        const text = await response.text();
        const comments = text.match(/<arxiv:comment>([^<]*)<\/arxiv:comment>/i)?.[1] ?? "";
        const status = verifyPublicationStatus({arxiv_id: id, comments});
        return {publication_status: status, source: "arxiv", venue: "arXiv"};
      }
    } catch {
      // fall through
    }
  }
  return {publication_status: heuristic, source: "heuristic"};
}
