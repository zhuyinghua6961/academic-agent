import {
  HandoffPacketSchema,
  SubagentReportSchema,
  utcNow,
  newId,
  type HandoffPacket,
  type SubagentRole,
  type SubagentReport,
} from "@academic-agent/schemas";

const SUBAGENT_ALLOWED_TOOLS: Record<SubagentRole, string[]> = {
  paper_reader: ["paper_read_section", "verify_publication_status"],
  novelty_reviewer: [],
  research_mentor: [],
  candidate_reviewer: [],
  ac_meta_review: [],
  experiment_architect: [],
  baseline_reviewer: ["paper_search"],
  metric_reviewer: [],
  experiment_ac: [],
};

export class SubagentPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentPermissionError";
  }
}

export function allowedToolsForRole(role: SubagentRole): string[] {
  return [...SUBAGENT_ALLOWED_TOOLS[role]];
}

export function createHandoffPacket(input: {
  threadId: string;
  runId: string;
  role: SubagentRole;
  task: string;
  payload?: Record<string, unknown>;
  sourceRefs?: string[];
  outputSchema: string;
  allowedTools?: string[];
}): HandoffPacket {
  const packet: HandoffPacket = {
    packet_id: newId("packet"),
    thread_id: input.threadId,
    run_id: input.runId,
    role: input.role,
    task: input.task,
    allowed_tools: input.allowedTools ?? allowedToolsForRole(input.role),
    payload: input.payload ?? {},
    source_refs: input.sourceRefs ?? [],
    output_schema: input.outputSchema,
    created_at: utcNow(),
  };
  return HandoffPacketSchema.parse(packet);
}

export function validateSubagentToolCall(role: SubagentRole, toolName: string): void {
  const allowed = allowedToolsForRole(role);
  if (!allowed.includes(toolName)) {
    throw new SubagentPermissionError(
      `Subagent ${role} is not allowed to call tool ${toolName}. Allowed: ${allowed.join(", ") || "none"}`,
    );
  }
}

export function createSubagentReport(input: {
  packet: HandoffPacket;
  output: Record<string, unknown>;
  sourceRefs?: string[];
  status?: "completed" | "failed";
  error?: string | null;
}): SubagentReport {
  const report: SubagentReport = {
    packet_id: input.packet.packet_id,
    role: input.packet.role,
    status: input.status ?? "completed",
    output: input.output,
    source_refs: input.sourceRefs ?? input.packet.source_refs,
    error: input.error ?? null,
    created_at: utcNow(),
  };
  return SubagentReportSchema.parse(report);
}

export type SubagentInvoker = (
  packet: HandoffPacket,
) => Promise<SubagentReport>;

export class SubagentHarness {
  private readonly invokers = new Map<SubagentRole, SubagentInvoker>();

  register(role: SubagentRole, invoker: SubagentInvoker): void {
    this.invokers.set(role, invoker);
  }

  async invoke(packet: HandoffPacket): Promise<SubagentReport> {
    const invoker = this.invokers.get(packet.role);
    if (!invoker) {
      return createSubagentReport({
        packet,
        output: {},
        status: "failed",
        error: `No invoker registered for subagent role: ${packet.role}`,
      });
    }
    HandoffPacketSchema.parse(packet);
    return invoker(packet);
  }

  async invokeSequential(packets: HandoffPacket[]): Promise<SubagentReport[]> {
    const reports: SubagentReport[] = [];
    for (const packet of packets) {
      reports.push(await this.invoke(packet));
    }
    return reports;
  }

  async invokeParallel(packets: HandoffPacket[]): Promise<SubagentReport[]> {
    return Promise.all(packets.map((packet) => this.invoke(packet)));
  }
}
