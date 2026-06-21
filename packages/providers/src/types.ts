import type {JsonObject, ProviderProfileConfig, ProviderRequest, ProviderResponse} from "@academic-agent/schemas";

export const PROMPT_VERSION = "idea-plan-diagnosis-v0.4";
export const APP_USER_AGENT = "academic-agent/0.1.0";

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export type ProviderStreamChunk = {
  type?: string;
  delta?: string;
  reasoning_delta?: string;
  tool_calls?: JsonObject[];
  response?: ProviderResponse;
};

export interface IdeaDiagnosisProvider {
  readonly config: ProviderProfileConfig;

  buildRequest(
    idea: string,
    contextId: string,
    history?: import("@academic-agent/schemas").ThreadMessage[],
  ): ProviderRequest;

  generateIdeaDiagnosis(request: ProviderRequest, idea: string): Promise<ProviderResponse>;

  generateThreadTitle(
    idea: string,
    diagnosis: import("@academic-agent/schemas").Diagnosis,
  ): Promise<string>;

  buildAgentRequest(
    messages: JsonObject[],
    tools?: JsonObject[] | null,
  ): ProviderRequest;

  generateAgentResponse(
    request: ProviderRequest,
    tools?: JsonObject[] | null,
  ): Promise<ProviderResponse>;

  streamAgentResponse(
    request: ProviderRequest,
    tools?: JsonObject[] | null,
  ): AsyncGenerator<ProviderStreamChunk> | null;
}
