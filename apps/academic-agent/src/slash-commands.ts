export const SLASH_COMMANDS = [
  "new",
  "resume",
  "rename",
  "status",
  "plan",
  "artifact",
  "context",
  "papers",
  "hooks",
  "disagreements",
  "convergence",
  "review",
  "meta-review",
  "freeze",
  "pause",
  "version",
  "experiment",
  "blueprint",
  "review-blueprint",
  "meta-review-blueprint",
  "freeze-blueprint",
  "back-to-plan",
  "read",
  "config",
  "cache",
  "clear-cache",
  "quit",
] as const;

export type SlashCommand = (typeof SLASH_COMMANDS)[number];

export function parseSlashCommand(raw: string): {command: SlashCommand; value: string} | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const [rawCommand, ...rest] = trimmed.slice(1).split(/\s+/);
  const command = rawCommand.toLowerCase() as SlashCommand;
  if (!SLASH_COMMANDS.includes(command)) {
    return null;
  }
  return {command, value: rest.join(" ").trim()};
}

export function slashSuggestion(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const fragment = trimmed.slice(1).toLowerCase();
  const match = SLASH_COMMANDS.find((command) => command.startsWith(fragment));
  return match ? `/${match}` : null;
}

export function formatConvergence(status: {
  can_enter_candidate_review: boolean;
  can_advance: boolean;
  can_freeze: boolean;
  can_enter_experiment_design: boolean;
  checks: Array<{id: string; layer: string; label: string; satisfied: boolean; detail?: string}>;
}): string {
  const lines = [
    "# Plan Convergence",
    "",
    `- Candidate review ready: ${status.can_enter_candidate_review ? "yes" : "no"}`,
    `- Can Advance: ${status.can_advance ? "yes" : "no"}`,
    `- Can Freeze: ${status.can_freeze ? "yes" : "no"}`,
    `- Can enter Experiment Design: ${status.can_enter_experiment_design ? "yes" : "no"}`,
    "",
    "## Checks",
  ];
  for (const check of status.checks) {
    const mark = check.satisfied ? "[x]" : "[ ]";
    const detail = check.detail ? ` (${check.detail})` : "";
    lines.push(`- ${mark} [${check.layer}] ${check.id}: ${check.label}${detail}`);
  }
  return lines.join("\n");
}

export function helpText(): string {
  return [
    "/new [IDEA]",
    "/resume [NAME]",
    "/status",
    "/papers",
    "/convergence",
    "/review Reject|Revise|Advance|Provisional",
    "/meta-review",
    "/freeze",
    "/experiment",
    "/blueprint",
    "/review-blueprint Freeze|Revise|Reject",
    "/freeze-blueprint",
    "/config",
    "/quit",
  ].join(", ");
}
