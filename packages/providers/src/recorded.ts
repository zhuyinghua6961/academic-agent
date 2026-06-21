import {existsSync, readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";

import {newId, utcNow, type Diagnosis, type JsonObject, type ProviderRequest, type ProviderResponse} from "@academic-agent/schemas";

import {BaseIdeaDiagnosisProvider} from "./base.js";
import {ProviderError} from "./types.js";

type PlaylistFile = {
  responses: string[];
};

function recordingsDir(env: Record<string, string>): string {
  const dir = env.ACADEMIC_AGENT_RECORDINGS_DIR;
  if (!dir) {
    throw new ProviderError(
      "ACADEMIC_AGENT_RECORDINGS_DIR is required when ACADEMIC_AGENT_RECORDED_PROVIDER=1",
    );
  }
  return dir;
}

function loadResponseFile(dir: string, fileName: string): ProviderResponse {
  const filePath = join(dir, fileName);
  if (!existsSync(filePath)) {
    throw new ProviderError(`Recorded response not found: ${filePath}`);
  }
  const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  const record = raw as ProviderResponse;
  return record;
}

export function recordedProviderEnabled(env?: Readonly<Record<string, string>>): boolean {
  const source = env ?? process.env;
  const value = source.ACADEMIC_AGENT_RECORDED_PROVIDER ?? "";
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export class RecordedProvider extends BaseIdeaDiagnosisProvider {
  private readonly dir: string;
  private readonly playlist: string[] | null;
  private playlistIndex = 0;
  private readonly hashCache = new Map<string, ProviderResponse>();

  constructor(config: import("@academic-agent/schemas").ProviderProfileConfig, env?: Readonly<Record<string, string>>) {
    super(config, env);
    const baseDir = recordingsDir(this.env);
    const profileDir = join(baseDir, config.profile);
    this.dir = existsSync(join(profileDir, "playlist.json")) || existsSync(profileDir)
      ? profileDir
      : baseDir;
    const playlistPath = join(this.dir, "playlist.json");
    if (existsSync(playlistPath)) {
      const playlist = JSON.parse(readFileSync(playlistPath, "utf8")) as PlaylistFile;
      this.playlist = playlist.responses ?? [];
    } else {
      this.playlist = null;
      for (const fileName of readdirSync(this.dir)) {
        if (!fileName.endsWith(".json") || fileName === "playlist.json") {
          continue;
        }
        const key = fileName.replace(/\.json$/, "");
        this.hashCache.set(key, loadResponseFile(this.dir, fileName));
      }
    }
  }

  private nextResponse(request: ProviderRequest): ProviderResponse {
    if (this.playlist !== null) {
      const fileName = this.playlist[this.playlistIndex];
      this.playlistIndex += 1;
      if (!fileName) {
        throw new ProviderError(
          `Recorded provider exhausted after ${this.playlistIndex - 1} responses (dir: ${this.dir})`,
        );
      }
      return loadResponseFile(this.dir, fileName);
    }
    const cached = this.hashCache.get(request.input_hash);
    if (!cached) {
      throw new ProviderError(
        `No recorded response for input_hash=${request.input_hash} in ${this.dir}`,
      );
    }
    return cached;
  }

  private wrapResponse(request: ProviderRequest, recorded: ProviderResponse): ProviderResponse {
    return {
      ...recorded,
      request_id: request.request_id,
      response_id: newId("provider_resp"),
      provider: this.config.provider,
      model: this.config.model,
      cached: true,
      created_at: utcNow(),
    };
  }

  async generateIdeaDiagnosis(request: ProviderRequest, idea: string): Promise<ProviderResponse> {
    const recorded = this.nextResponse(request);
    const diagnosis = (recorded.output as {diagnosis?: Diagnosis}).diagnosis;
    if (!diagnosis) {
      throw new ProviderError("Recorded response missing diagnosis output");
    }
    return this.wrapResponse(request, {
      ...recorded,
      output: {diagnosis},
    });
  }

  async generateThreadTitle(idea: string): Promise<string> {
    return this.fallbackThreadTitle(idea);
  }

  async generateAgentResponse(
    request: ProviderRequest,
    _tools: JsonObject[] | null = null,
  ): Promise<ProviderResponse> {
    return this.wrapResponse(request, this.nextResponse(request));
  }

  streamAgentResponse(): null {
    return null;
  }
}
