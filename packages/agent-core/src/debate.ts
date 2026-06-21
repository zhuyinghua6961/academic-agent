import {AgentConfig} from "@academic-agent/config";
import {createIdeaDiagnosisProvider} from "@academic-agent/providers";

export async function detectUserDisagreementLLM(
  projectRoot: string,
  userMessage: string,
  agentClaim: string,
): Promise<boolean> {
  const markers = ["不同意", "我坚持", "but i think", "disagree", "反对"];
  const lower = userMessage.toLowerCase();
  if (markers.some((m) => lower.includes(m.toLowerCase()))) {
    return true;
  }

  const config = AgentConfig.load(projectRoot);
  const provider = createIdeaDiagnosisProvider(config.profile("extractor"), config.env);
  const request = provider.buildAgentRequest(
    [
      {
        role: "system",
        content:
          "Detect whether the user disagrees with the agent's research claim. Reply JSON only: {\"disagreement\":true|false,\"reason\":\"...\"}",
      },
      {
        role: "user",
        content: JSON.stringify({user_message: userMessage, agent_claim: agentClaim}),
      },
    ],
    [],
  );
  try {
    const response = await provider.generateAgentResponse(request, []);
    const content = String(response.output.content ?? "");
    const parsed = JSON.parse(content) as {disagreement?: boolean};
    return parsed.disagreement === true;
  } catch {
    return false;
  }
}
