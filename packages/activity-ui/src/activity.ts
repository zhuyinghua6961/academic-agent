import type {SSEEvent, ToolCall} from "@academic-agent/schemas";

import {
  toolDecisionMessage,
  toolObservationMessage,
  toolStartMessage,
} from "./tool-messages.js";

export type ActivityEntry = {
  id: string;
  stage: string;
  status: "started" | "updated" | "completed" | "error";
  message: string;
  createdAt: string;
};

const ACTIVITY_STATUSES = new Set(["started", "updated", "completed"]);

export function isUserVisibleActivityEvent(eventType: string): boolean {
  if (eventType.startsWith("activity.")) {
    return true;
  }
  if (eventType === "run.failed") {
    return true;
  }
  return false;
}

function activityStatusFromEventType(eventType: string): ActivityEntry["status"] {
  if (eventType === "run.failed") {
    return "error";
  }
  if (!eventType.startsWith("activity.")) {
    return "updated";
  }
  const status = eventType.replace("activity.", "");
  return ACTIVITY_STATUSES.has(status) ? (status as ActivityEntry["status"]) : "updated";
}

function activityFromPayload(event: SSEEvent): ActivityEntry {
  return {
    id: event.event_id,
    stage: String(event.payload?.stage ?? "working"),
    status: activityStatusFromEventType(event.event_type),
    message: String(event.payload?.message ?? event.event_type),
    createdAt: event.created_at,
  };
}

export function activityFromEvent(event: SSEEvent): ActivityEntry | null {
  if (event.event_type === "run.failed") {
    return {
      id: event.event_id,
      stage: "error",
      status: "error",
      message: String(event.payload?.error ?? "Run failed."),
      createdAt: event.created_at,
    };
  }

  if (isUserVisibleActivityEvent(event.event_type)) {
    return activityFromPayload(event);
  }

  if (event.event_type === "action.started") {
    const toolName = String(event.payload?.tool_name ?? "tool");
    const args =
      event.payload?.arguments && typeof event.payload.arguments === "object"
        ? (event.payload.arguments as Record<string, unknown>)
        : {};
    return {
      id: event.event_id,
      stage: toolName === "paper_search" || toolName === "web_search" ? "searching" : "acting",
      status: "started",
      message: toolStartMessage(toolName, args),
      createdAt: event.created_at,
    };
  }

  if (event.event_type === "observation.summary") {
    const toolName = String(event.payload?.tool_name ?? "tool");
    const isError = Boolean(event.payload?.error);
    const summary = {...event.payload};
    return {
      id: event.event_id,
      stage: "observing",
      status: isError ? "error" : "completed",
      message: toolObservationMessage(toolName, summary, isError),
      createdAt: event.created_at,
    };
  }

  if (event.event_type === "decision.made") {
    const toolNames = Array.isArray(event.payload?.tool_names)
      ? event.payload.tool_names.map((name) => String(name))
      : [];
    const toolCalls: ToolCall[] = toolNames.map((name, index) => ({
      call_id: `decision_${index}`,
      name,
      arguments: {},
    }));
    return {
      id: event.event_id,
      stage: "deciding",
      status: "updated",
      message: toolDecisionMessage(toolCalls),
      createdAt: event.created_at,
    };
  }

  if (event.event_type === "literature.auto_mini_review") {
    return null;
  }

  if (event.event_type === "literature.auto_hooks") {
    const written = Number(event.payload?.written ?? 0);
    if (written <= 0) {
      return null;
    }
    return {
      id: event.event_id,
      stage: "literature",
      status: "completed",
      message: `从精读结果提取 ${written} 条创新 hook`,
      createdAt: event.created_at,
    };
  }

  return null;
}
