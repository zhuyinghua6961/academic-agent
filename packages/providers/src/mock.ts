import {newId, utcNow, type Diagnosis, type JsonObject, type ProviderRequest, type ProviderResponse} from "@academic-agent/schemas";

import {BaseIdeaDiagnosisProvider} from "./base.js";
import {latestUserInputFromAgentContent} from "./prompts.js";

export class DeterministicMockProvider extends BaseIdeaDiagnosisProvider {
  async generateIdeaDiagnosis(request: ProviderRequest, idea: string): Promise<ProviderResponse> {
    const diagnosis = this.mockDiagnosis(idea);
    return {
      response_id: newId("provider_resp"),
      request_id: request.request_id,
      provider: this.config.provider,
      model: this.config.model,
      output: {diagnosis},
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        note: "deterministic mock provider",
      },
      cached: false,
      created_at: utcNow(),
    };
  }

  async generateThreadTitle(idea: string, _diagnosis: Diagnosis): Promise<string> {
    return this.fallbackThreadTitle(idea);
  }

  async generateAgentResponse(
    request: ProviderRequest,
    _tools: JsonObject[] | null = null,
  ): Promise<ProviderResponse> {
    let idea = "";
    for (const message of [...request.messages].reverse()) {
      if (message.role === "user" && typeof message.content === "string") {
        idea = latestUserInputFromAgentContent(message.content);
        break;
      }
    }
    const diagnosisJson = JSON.stringify(this.mockDiagnosis(idea));
    return {
      response_id: newId("provider_resp"),
      request_id: request.request_id,
      provider: this.config.provider,
      model: this.config.model,
      output: {
        content: diagnosisJson,
        tool_calls: [],
        finish_reason: "stop",
      },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        note: "deterministic mock agent provider",
      },
      cached: false,
      created_at: utcNow(),
    };
  }

  streamAgentResponse(
    _request: ProviderRequest,
    _tools: JsonObject[] | null = null,
  ): AsyncGenerator<import("./types.js").ProviderStreamChunk> | null {
    return null;
  }

  private mockDiagnosis(idea: string): Diagnosis {
    const cleaned = idea.trim().split(/\s+/).join(" ");
    return {
      problem: `用户提出的研究方向是：${cleaned}`,
      gap:
        "v0 尚未检索近邻论文，因此只能把 gap 标记为待证伪假设；" +
        "后续必须通过 Idea Plan Mode 的文献检索确认 novelty。",
      candidate_mechanism:
        "候选机制应被重构为一个可被实验验证的核心算法或交互机制，" +
        "而不是简单的 LLM/RAG/workflow 拼装。",
      evidence_needed: [
        "检索 5-8 篇最接近的顶会论文并产出 mini-review。",
        "定义主 claim、失败标准和可区分近邻工作的机制假设。",
        "设计能支持、削弱或推翻主 claim 的实验蓝图。",
      ],
      main_uncertainty:
        "当前最大不确定性是：该 idea 是否存在真实机制创新，" +
        "以及能否通过强 baseline 与 ablation 排除工程拼装解释。",
      clarifying_questions: [
        `围绕“${cleaned}”，目标任务、输入输出和使用场景分别是什么？`,
        "你希望核心创新落在模型机制、数据/benchmark、评估方法，还是人机交互流程？",
        "可用数据、算力、标注预算和强 baseline 分别是什么？",
      ],
    };
  }
}
