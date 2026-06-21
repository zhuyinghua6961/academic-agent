import {AgentConfig} from "@academic-agent/config";
import {createIdeaDiagnosisProvider} from "@academic-agent/providers";
import {ImpactLevelSchema, type ImpactLevel} from "@academic-agent/schemas";

export async function classifyImpact(
  projectRoot: string,
  previousClaim: string,
  userMessage: string,
): Promise<ImpactLevel> {
  const config = AgentConfig.load(projectRoot);
  const provider = createIdeaDiagnosisProvider(config.profile("extractor"), config.env);
  const request = provider.buildAgentRequest(
    [
      {
        role: "system",
        content:
          "Classify how much the user correction changes the research idea. " +
          "Reply JSON only: {\"impact_level\":\"None|Minor|Major|Fatal\",\"reason\":\"...\"}",
      },
      {
        role: "user",
        content: JSON.stringify({previous_claim: previousClaim, user_correction: userMessage}),
      },
    ],
    [],
  );
  const response = await provider.generateAgentResponse(request, []);
  const content = String(response.output.content ?? "");
  try {
    const parsed = JSON.parse(content) as {impact_level?: string};
    return ImpactLevelSchema.parse(parsed.impact_level ?? "Minor");
  } catch {
    const lower = userMessage.toLowerCase();
    if (lower.includes("完全不同") || lower.includes("换一个方向") || lower.includes("fatal")) {
      return "Fatal";
    }
    if (lower.includes("改") || lower.includes("不对") || lower.includes("change")) {
      return "Major";
    }
    return "Minor";
  }
}
