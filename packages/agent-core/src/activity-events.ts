import type {WorkspacePort} from "@academic-agent/workspace-port";

export function emitActivity(
  workspace: WorkspacePort,
  runId: string,
  eventType: string,
  stage: string,
  message: string,
  payload: Record<string, unknown> = {},
): void {
  workspace.add_event(runId, eventType, {stage, message, ...payload});
}

export {
  activityFromEvent,
  isUserVisibleActivityEvent,
  type ActivityEntry,
} from "@academic-agent/activity-ui";
