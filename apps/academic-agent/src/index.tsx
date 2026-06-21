#!/usr/bin/env node
import React, {memo, useCallback, useEffect, useMemo, useRef, useState} from "react";
import {Box, Text, render, useApp, useInput} from "ink";
import {activityFromEvent, type ActivityEntry} from "@academic-agent/agent-core";
import {AcademicAgentClient, isConfigurationRequired} from "./client.js";
import {SetupWizard} from "./setup-wizard.js";
import type {
  AppCacheClearResponse,
  AppCacheListResponse,
  ArtifactReadResponse,
  ContextUsageResponse,
  CurrentIdeaPlanResponse,
  FreezeIdeaPlanResponse,
  ProviderProfileStatus,
  ProviderProfilesResponse,
  ModeRun,
  ThreadSessionSummary,
  ThreadMessage,
  ThreadListResponse,
  ThreadMessagesResponse,
  WorkflowThread,
  RunResultResponse,
  SSEEvent,
  StartIdeaPlanRunResponse,
  ReviewIdeaPlanResponse,
  ReviewIdeaPlanRequest,
  SetupStatusResponse,
  ThreadContextResponse,
} from "@academic-agent/schemas";
import {
  formatConvergence,
  helpText,
  parseSlashCommand,
  slashSuggestion,
} from "./slash-commands.js";

type Args = {
  projectRoot: string;
  idea?: string;
  resume?: string;
  resumeList: boolean;
  help: boolean;
  once: boolean;
};

type UiState = "setup-loading" | "setup" | "input" | "loading" | "running" | "completed" | "resume-list" | "error";

const ACTIVITY_PREVIEW_LIMIT = 12;

const STAGE_LABELS: Record<string, string> = {
  planning: "规划",
  thinking: "推理",
  deciding: "决策",
  searching: "检索",
  observing: "结果",
  reading: "精读",
  literature: "文献",
  evidence: "证据",
  context: "上下文",
  answering: "回答",
  synthesizing: "收束",
  acting: "工具",
  working: "进行",
  error: "错误",
};

const visibleActivities = (activities: ActivityEntry[], expanded: boolean): ActivityEntry[] =>
  expanded || activities.length <= ACTIVITY_PREVIEW_LIMIT
    ? activities
    : activities.slice(-ACTIVITY_PREVIEW_LIMIT);

function createBatchedRunEventHandler(options: {
  setActivities: (activities: ActivityEntry[]) => void;
  setAssistantDraft: React.Dispatch<React.SetStateAction<string>>;
  setStepCount: (count: number) => void;
  flushMs?: number;
}) {
  const runActivities: ActivityEntry[] = [];
  let pendingAssistantDelta = "";
  let pendingAssistantReset = false;
  let dirtyActivities = false;
  let assistantStreamUnlocked = false;
  let flushTimer: NodeJS.Timeout | null = null;
  const flushMs = options.flushMs ?? LIVE_UI_FLUSH_MS;

  const flush = () => {
    flushTimer = null;
    if (pendingAssistantReset) {
      options.setAssistantDraft("");
      pendingAssistantReset = false;
      pendingAssistantDelta = "";
    } else if (pendingAssistantDelta.length > 0) {
      const nextDelta = pendingAssistantDelta;
      pendingAssistantDelta = "";
      options.setAssistantDraft((current) => `${current}${nextDelta}`);
    }
    if (dirtyActivities) {
      options.setActivities([...runActivities]);
      options.setStepCount(runActivities.length);
      dirtyActivities = false;
    }
  };

  const scheduleFlush = () => {
    if (flushTimer) {
      return;
    }
    flushTimer = setTimeout(flush, flushMs);
  };

  const onEvent = (event: SSEEvent) => {
    const activity = activityFromEvent(event);
    if (activity) {
      runActivities.push(activity);
      dirtyActivities = true;
    }
    if (isFinalAnswerReset(event)) {
      assistantStreamUnlocked = true;
      pendingAssistantDelta = "";
      pendingAssistantReset = true;
    } else if (isUserVisibleAssistantDelta(event, assistantStreamUnlocked)) {
      const delta = String(event.payload?.delta ?? "");
      if (delta) {
        pendingAssistantDelta += delta;
      }
    }
    scheduleFlush();
  };

  return {
    onEvent,
    flush,
    dispose: () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
    },
    getRunActivities: () => runActivities,
  };
}

const activityStreamFooter = (
  activities: ActivityEntry[],
  expanded: boolean,
): string => {
  const total = activities.length;
  if (total === 0) {
    return "";
  }
  const shown = visibleActivities(activities, expanded).length;
  if (total <= ACTIVITY_PREVIEW_LIMIT) {
    return `共 ${total} 步`;
  }
  if (expanded) {
    return `已展开全部 ${total} 步 · 按 e 收起`;
  }
  return `显示最近 ${shown} / ${total} 步 · 按 e 展开`;
};

type TranscriptEntry =
  | {id: string; kind: "message"; role: ThreadMessage["role"]; content: string; runId?: string | null}
  | {id: string; kind: "activity"; title: string; activities: ActivityEntry[]; stepCount: number}
  | {id: string; kind: "info"; title: string; content: string}
  | {id: string; kind: "error"; message: string};

type ThreadSessionLike = Partial<ThreadSessionSummary> & Partial<WorkflowThread>;

const LIVE_UI_FLUSH_MS = 200;
const WORKING_TRANSCRIPT_LIMIT = 4;

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    projectRoot: process.env.ACADEMIC_AGENT_PROJECT_ROOT ?? process.cwd(),
    resumeList: false,
    help: false,
    once: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--once") {
      args.once = true;
    } else if (arg === "--project-root") {
      args.projectRoot = argv[index + 1] ?? args.projectRoot;
      index += 1;
    } else if (arg === "--resume" || arg === "resume") {
      const next = argv[index + 1];
      if (!next || next.startsWith("-")) {
        args.resumeList = true;
      } else {
        args.resume = next;
        index += 1;
      }
    } else if (arg === "--idea") {
      args.idea = argv[index + 1] ?? "";
      index += 1;
    }
  }
  return args;
};

const interruptErrorMessage = (message: string): string => {
  if (message.startsWith("404 ")) {
    if (message.includes("Unknown run")) {
      return (
        "Cannot interrupt this run because the current core does not recognize it. " +
        "The core may have been restarted; resume the session or start a new run."
      );
    }
    return (
      "Cannot interrupt because the running core does not expose /runs/{id}/cancel. " +
      "Restart the local core, then run academic-agent again."
    );
  }
  return message;
};

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";

const isRunNotCompletedError = (message: string): boolean =>
  message.startsWith("409 ") && message.includes("is not completed");

function loadCompletedRunResult(
  client: AcademicAgentClient,
  runId: string,
  threadId: string,
): Pick<RunResultResponse, "thread" | "messages"> {
  try {
    const result = client.getRunResult(runId);
    return {thread: result.thread, messages: result.messages ?? []};
  } catch {
    const response = client.readThreadMessages(threadId);
    return {thread: response.thread, messages: response.messages};
  }
}

function isUserVisibleAssistantDelta(event: SSEEvent, streamUnlocked: boolean): boolean {
  if (event.event_type !== "assistant.delta") {
    return false;
  }
  const source = String(event.payload?.source ?? "");
  if (source === "provider_stream") {
    return false;
  }
  return streamUnlocked || source === "final_answer";
}

function isFinalAnswerReset(event: SSEEvent): boolean {
  return event.event_type === "assistant.reset" && event.payload?.reason === "final_answer";
}

const transcriptFromMessagesWithActivity = (
  messages: ThreadMessage[],
  activityHistory: Record<string, {activities: ActivityEntry[]; stepCount: number}>,
): TranscriptEntry[] => {
  const entries: TranscriptEntry[] = [];
  const insertedActivityRunIds = new Set<string>();
  for (const message of messages.filter((item) => item.role !== "tool")) {
    const runId = message.run_id;
    const runActivity = runId ? activityHistory[runId] : undefined;
    if (
      message.role === "assistant" &&
      runId &&
      runActivity &&
      runActivity.activities.length > 0 &&
      !insertedActivityRunIds.has(runId)
    ) {
      entries.push({
        id: `activity_${runId}`,
        kind: "activity",
        title: "工作轨迹",
        activities: runActivity.activities,
        stepCount: runActivity.stepCount ?? runActivity.activities.length,
      });
      insertedActivityRunIds.add(runId);
    }
    entries.push({
      id: message.message_id,
      kind: "message",
      role: message.role,
      content: message.content,
      runId,
    });
  }
  return entries;
};

const normalizeThreadSession = (thread: ThreadSessionLike): ThreadSessionSummary | null => {
  if (!thread.thread_id || !thread.project_id || !thread.created_at) {
    return null;
  }
  const messageCount =
    typeof thread.message_count === "number" ? thread.message_count : 1;
  return {
    thread_id: thread.thread_id,
    project_id: thread.project_id,
    title: thread.title ?? thread.name ?? `Untitled ${thread.thread_id.slice(-6)}`,
    name: thread.name ?? null,
    created_at: thread.created_at,
    updated_at: thread.updated_at ?? thread.created_at,
    message_count: messageCount,
    latest_run_id: thread.latest_run_id ?? null,
    latest_status: thread.latest_status ?? null,
    session_status: thread.session_status ?? null,
    latest_artifact_type: thread.latest_artifact_type ?? null,
    latest_artifact_status: thread.latest_artifact_status ?? null,
  };
};

const normalizeThreadSessions = (threads: ThreadSessionLike[]): ThreadSessionSummary[] =>
  threads
    .map(normalizeThreadSession)
    .filter((thread): thread is ThreadSessionSummary => Boolean(thread))
    .filter((thread) => thread.message_count > 0);

const formatElapsed = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const formatAbsoluteTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const formatRelativeTime = (value: string, now = Date.now()): string => {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return "unknown";
  }
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) {
    return "刚刚";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}小时前`;
  }
  const days = Math.floor(hours / 24);
  return `${days}天前`;
};

const estimateDraftTokens = (text: string, charsPerToken: number): number => {
  if (text.trim().length === 0) {
    return 0;
  }
  return Math.max(1, Math.floor((text.length + 16) / Math.max(1, charsPerToken)));
};

const contextUsageWithDraft = (
  usage: ContextUsageResponse | null,
  draft: string,
): ContextUsageResponse | null => {
  if (!usage) {
    return null;
  }
  const draftTokens = estimateDraftTokens(draft, usage.chars_per_token);
  const estimatedTotal =
    usage.estimated_thread_tokens + usage.estimated_artifact_tokens + draftTokens;
  const estimatedContext = Math.min(
    usage.context_window_tokens,
    usage.estimated_context_tokens + draftTokens,
  );
  return {
    ...usage,
    estimated_draft_tokens: draftTokens,
    estimated_total_tokens: estimatedTotal,
    estimated_context_tokens: estimatedContext,
    usage_ratio:
      usage.context_window_tokens > 0
        ? Number((estimatedContext / usage.context_window_tokens).toFixed(4))
        : 0,
    threshold_ratio:
      usage.compact_threshold_tokens > 0
        ? Number((usage.estimated_thread_tokens / usage.compact_threshold_tokens).toFixed(4))
        : 0,
    should_compact: usage.estimated_thread_tokens > usage.compact_threshold_tokens,
  };
};

const formatTokenCount = (tokens: number): string =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 1 : 2)}k` : String(tokens);

const transcriptWindow = (
  transcript: TranscriptEntry[],
  isWorking: boolean,
): {entries: TranscriptEntry[]; hiddenCount: number} => {
  if (!isWorking || transcript.length <= WORKING_TRANSCRIPT_LIMIT) {
    return {entries: transcript, hiddenCount: 0};
  }
  return {
    entries: transcript.slice(-WORKING_TRANSCRIPT_LIMIT),
    hiddenCount: transcript.length - WORKING_TRANSCRIPT_LIMIT,
  };
};

const currentPlanText = (plan: CurrentIdeaPlanResponse): string => {
  const diagnosis = plan.draft?.diagnosis;
  if (!plan.artifact || !diagnosis) {
    return "No current ResearchIdeaPlanDraft yet. Start or continue an Idea Plan run first.";
  }
  return [
    `Status: ${plan.session_status}`,
    `Artifact: ${plan.artifact.path}`,
    `Type: ${plan.artifact.artifact_type}`,
    "",
    `Problem: ${diagnosis.problem}`,
    `Gap: ${diagnosis.gap}`,
    `Candidate mechanism: ${diagnosis.candidate_mechanism}`,
    `Main uncertainty: ${diagnosis.main_uncertainty}`,
  ].join("\n");
};

const artifactText = (artifact: ArtifactReadResponse): string =>
  [
    `Artifact: ${artifact.metadata.path}`,
    `Type: ${artifact.metadata.artifact_type}`,
    `Status: ${artifact.metadata.status}`,
    "",
    artifact.content.trim() || "Artifact content is empty.",
  ].join("\n");

const contextText = (response: ThreadContextResponse): string =>
  (() => {
    const sourceRefs = response.artifact_context.source_refs ?? [];
    return [
      `Thread: ${response.thread.name ?? response.thread.thread_id}`,
      `Estimated tokens: ${formatTokenCount(
        response.artifact_context.estimated_tokens,
      )} / ${formatTokenCount(response.artifact_context.token_budget)}`,
      `Source refs: ${sourceRefs.join(", ") || "None"}`,
      "",
      response.content.trim() || "No artifact-first context has been built for this thread yet.",
    ].join("\n");
  })();

const frozenPlanText = (result: FreezeIdeaPlanResponse): string =>
  [
    "ResearchIdeaPlan frozen.",
    `Artifact: ${result.artifact.path}`,
    `Source draft: ${result.plan.source_draft_artifact_id}`,
    `Frozen at: ${result.plan.frozen_at}`,
    "",
    `Problem: ${result.plan.diagnosis.problem}`,
    `Main uncertainty: ${result.plan.diagnosis.main_uncertainty}`,
  ].join("\n");

const parseReviewCommandValue = (
  value: string,
): {
  decision: "Reject" | "Revise" | "Advance" | "Provisional";
  notes: string | null;
  scores?: ReviewIdeaPlanRequest["scores"];
  confidence?: ReviewIdeaPlanRequest["confidence"];
} | null => {
  const tokens = value.trim().split(/\s+/);
  const rawDecision = tokens[0];
  const normalized = rawDecision?.toLowerCase();
  const decision =
    normalized === "reject"
      ? "Reject"
      : normalized === "revise"
        ? "Revise"
        : normalized === "advance"
          ? "Advance"
          : normalized === "provisional"
            ? "Provisional"
            : null;
  if (!decision) {
    return null;
  }
  let scores: ReviewIdeaPlanRequest["scores"];
  let confidence: ReviewIdeaPlanRequest["confidence"];
  const noteParts: string[] = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--scores") {
      scores = {};
      for (let j = i + 1; j < tokens.length; j += 1) {
        const scoreToken = tokens[j];
        if (scoreToken.startsWith("--")) {
          i = j - 1;
          break;
        }
        const [key, rawValue] = scoreToken.split("=");
        const parsed = Number(rawValue);
        if (
          key &&
          Number.isInteger(parsed) &&
          parsed >= 0 &&
          parsed <= 6 &&
          (key === "originality" ||
            key === "significance" ||
            key === "soundness" ||
            key === "clarity" ||
            key === "feasibility_resource_fit")
        ) {
          scores[key] = parsed;
        }
        i = j;
      }
      continue;
    }
    if (token === "--confidence") {
      const next = tokens[i + 1]?.toLowerCase();
      if (next === "high" || next === "medium" || next === "low") {
        confidence = next;
        i += 1;
      }
      continue;
    }
    noteParts.push(token);
  }
  const notes = noteParts.join(" ").trim();
  return {
    decision,
    notes: notes.length > 0 ? notes : null,
    scores,
    confidence,
  };
};

const parseReadingCommandValue = (
  value: string,
): {mode: "quick" | "guided" | "exam"; paper_id: string; query?: string} | null => {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return {mode: "guided", paper_id: ""};
  }
  const modeToken = tokens[0].toLowerCase();
  if (modeToken === "quick" || modeToken === "guided" || modeToken === "exam") {
    const paperId = tokens[1] ?? "";
    const query = tokens.slice(2).join(" ").trim();
    if (!paperId) {
      return null;
    }
    return {mode: modeToken, paper_id: paperId, query: query || undefined};
  }
  return {mode: "guided", paper_id: tokens[0], query: tokens.slice(1).join(" ").trim() || undefined};
};

const reviewText = (response: ReviewIdeaPlanResponse): string =>
  [
    `Decision: ${response.decision}`,
    `Session status: ${response.session_status}`,
    response.notes ? `Notes: ${response.notes}` : "Notes: none",
  ].join("\n");

const App = ({args}: {args: Args}) => {
  const {exit} = useApp();
  const client = useMemo(() => new AcademicAgentClient(args.projectRoot), [args.projectRoot]);
  const transcriptEntryId = useRef(0);
  const initialCommandHandled = useRef(false);
  const activeRunAbortController = useRef<AbortController | null>(null);
  const activeRunId = useRef<string | null>(null);
  const activeRunThreadId = useRef<string | null>(null);
  const activeRunSequence = useRef(0);
  const interruptedRunIds = useRef<Set<string>>(new Set());
  const activityHistoryRef = useRef<Record<string, {activities: ActivityEntry[]; stepCount: number}>>({});
  const [idea, setIdea] = useState(args.idea ?? "");
  const [reply, setReply] = useState("");
  const [state, setState] = useState<UiState>("setup-loading");
  const [setupConfigured, setSetupConfigured] = useState(false);
  const [setupStatus, setSetupStatus] = useState<SetupStatusResponse | null>(null);
  const [setupMode, setSetupMode] = useState<"first-run" | "reconfigure">("first-run");
  const stateBeforeSetupRef = useRef<UiState>("input");
  const [stepCount, setStepCount] = useState(0);
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [activitiesExpanded, setActivitiesExpanded] = useState(false);
  const [assistantDraft, setAssistantDraft] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [resumeChoices, setResumeChoices] = useState<ThreadSessionSummary[]>([]);
  const [selectedResumeIndex, setSelectedResumeIndex] = useState(0);
  const [providerProfile, setProviderProfile] = useState<ProviderProfileStatus | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workingStartedAt, setWorkingStartedAt] = useState<number | null>(
    args.resume || args.resumeList || args.idea ? Date.now() : null,
  );
  const [clockNow, setClockNow] = useState(() => Date.now());

  const canSubmit = useMemo(() => idea.trim().length > 0, [idea]);
  const canReply = useMemo(() => reply.trim().length > 0, [reply]);
  const inputEnabled = Boolean(process.stdin.isTTY && process.stdin.setRawMode);
  const isWorking = state === "loading" || state === "running";
  const workingLabel = state === "loading" ? "loading" : "running";
  const activeInput = state === "input" ? idea : reply;
  const activeSlashSuggestion = slashSuggestion(activeInput);
  const activeContextUsage = useMemo(
    () => contextUsageWithDraft(contextUsage, activeInput),
    [activeInput, contextUsage],
  );
  const visibleTranscript = useMemo(
    () => transcriptWindow(transcript, isWorking),
    [isWorking, transcript],
  );
  const filteredResumeChoices = useMemo(() => {
    const query = reply.trim().toLowerCase();
    if (!query) {
      return resumeChoices;
    }
    return resumeChoices.filter((thread) =>
      [thread.title, thread.name ?? "", thread.thread_id]
        .join("\n")
        .toLowerCase()
        .includes(query),
    );
  }, [reply, resumeChoices]);

  const nextTranscriptEntryId = useCallback(() => {
    const id = `entry_${transcriptEntryId.current}`;
    transcriptEntryId.current += 1;
    return id;
  }, []);

  const refreshContextUsage = useCallback(
    async (targetThreadId: string | null = threadId, draft = "") => {
      try {
        const query = draft ? `?draft=${encodeURIComponent(draft)}` : "";
        const usage = client.contextUsage(targetThreadId ?? undefined, draft.trim());
        setContextUsage(usage);
      } catch {
        // Context usage is informational; do not block the main TUI when core is booting.
      }
    },
    [client, threadId],
  );

  const refreshSessionStatus = useCallback(
    async (targetThreadId: string | null = threadId): Promise<CurrentIdeaPlanResponse | null> => {
      if (!targetThreadId) {
        setSessionStatus(null);
        return null;
      }
      try {
        const plan = client.readThreadPlan(targetThreadId);
        setSessionStatus(plan.session_status);
        return plan;
      } catch {
        setSessionStatus(null);
        return null;
      }
    },
    [client, threadId],
  );

  useEffect(() => {
    if (!isWorking) {
      setWorkingStartedAt(null);
      return;
    }
    setWorkingStartedAt((current) => current ?? Date.now());
  }, [isWorking]);

  useEffect(() => {
    if (state !== "resume-list") {
      return;
    }
    setClockNow(Date.now());
    const timer = setInterval(() => {
      setClockNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [state]);

  useEffect(() => {
    if (!setupConfigured) {
      return;
    }
    void refreshContextUsage(threadId, "");
  }, [refreshContextUsage, setupConfigured, threadId]);

  useEffect(() => {
    if (!setupConfigured) {
      return;
    }
    void refreshSessionStatus(threadId);
  }, [refreshSessionStatus, setupConfigured, threadId]);

  const syncProviderProfile = useCallback(() => {
    const profiles = client.providerProfiles();
    setProviderProfile(
      (profiles.profiles ?? []).find((item) => item.profile === "planner") ?? null,
    );
  }, [client]);

  const restoreUiAfterSetup = useCallback(() => {
    const previous = stateBeforeSetupRef.current;
    if (threadId && (previous === "completed" || previous === "running" || previous === "loading")) {
      setState("completed");
      return;
    }
    if (previous !== "setup" && previous !== "setup-loading") {
      setState(previous);
      return;
    }
    setState(threadId ? "completed" : "input");
  }, [threadId]);

  const handleSetupComplete = useCallback(
    (_status: SetupStatusResponse) => {
      setSetupConfigured(true);
      syncProviderProfile();
      setError(null);
      restoreUiAfterSetup();
    },
    [restoreUiAfterSetup, syncProviderProfile],
  );

  const dismissSetupWizard = useCallback(() => {
    setError(null);
    restoreUiAfterSetup();
  }, [restoreUiAfterSetup]);

  const openSetupWizard = useCallback(() => {
    try {
      stateBeforeSetupRef.current = state;
      setSetupMode("reconfigure");
      const status = client.setupStatus();
      setSetupStatus(status);
      setState("setup");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      setState("error");
    }
  }, [client, state]);

  useEffect(() => {
    try {
      client.initProject();
      const status = client.setupStatus();
      setSetupStatus(status);
      syncProviderProfile();
      if (status.setup_required) {
        setSetupConfigured(false);
        setSetupMode("first-run");
        stateBeforeSetupRef.current = "input";
        setState("setup");
        return;
      }
      setSetupConfigured(true);
      setState(args.resume || args.resumeList ? "loading" : args.idea ? "running" : "input");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      setState("error");
    }
  }, [args.idea, args.resume, args.resumeList, client, syncProviderProfile]);

  useEffect(() => {
    if (state !== "resume-list") {
      return;
    }
    if (filteredResumeChoices.length === 0) {
      setSelectedResumeIndex(0);
      return;
    }
    setSelectedResumeIndex((current) =>
      Math.min(current, filteredResumeChoices.length - 1),
    );
  }, [filteredResumeChoices.length, state]);

  const loadThreadSession = useCallback(
    async (thread: WorkflowThread) => {
      setState("loading");
      const messagesResponse = client.readThreadMessages(thread.thread_id);
      const messages = messagesResponse.messages ?? [];
      setThreadId(messagesResponse.thread.thread_id);
      setSessionName(messagesResponse.thread.name ?? null);
      setTranscript(transcriptFromMessagesWithActivity(messages, activityHistoryRef.current));
      void refreshContextUsage(messagesResponse.thread.thread_id, "");
      void refreshSessionStatus(messagesResponse.thread.thread_id);
      setRunId(null);
      setStepCount(0);
      setActivities([]);
      setActivitiesExpanded(false);
      setAssistantDraft("");
      setError(null);
      setReply("");
      setIdea("");

      setState("completed");
    },
    [client, refreshContextUsage, refreshSessionStatus],
  );

  const loadThreadSessionById = useCallback(
    async (targetThreadId: string) => {
      const thread = client.getThread(targetThreadId);
      await loadThreadSession(thread);
    },
    [client, loadThreadSession],
  );

  const resumeThreadByName = useCallback(
    async (name: string) => {
      const normalized = name.trim();
      if (!normalized) {
        setError("Session name cannot be empty");
        setState(threadId ? "completed" : "input");
        return;
      }
      setError(null);
      setState("loading");
      try {
        client.initProject();
        const thread = client.findThreadByName(normalized);
        await loadThreadSession(thread);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message);
        setState(threadId ? "completed" : "input");
      }
    },
    [client, loadThreadSession, threadId],
  );

  const showResumeList = useCallback(async () => {
    setError(null);
    setReply("");
    setState("loading");
    try {
      client.initProject();
      const response = client.listThreads();
      const threads = normalizeThreadSessions(response.threads ?? []).reverse();
      setResumeChoices(threads);
      setSelectedResumeIndex(Math.max(0, threads.length - 1));
      if (threads.length === 0) {
        setTranscript((current) => [
          ...current,
          {
            id: nextTranscriptEntryId(),
            kind: "info",
            title: "Resume",
            content: "No saved sessions yet.",
          },
        ]);
        setState(threadId ? "completed" : "input");
        return;
      }
      setState("resume-list");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      setTranscript((current) => [
        ...current,
        {id: nextTranscriptEntryId(), kind: "error", message},
      ]);
      setState(threadId ? "completed" : "input");
    }
  }, [client, nextTranscriptEntryId, threadId]);

  const resumeSelectedThread = useCallback(async () => {
    const selection = reply.trim();
    try {
      const selected = filteredResumeChoices[selectedResumeIndex];
      if (!selection && selected) {
        await loadThreadSessionById(selected.thread_id);
        return;
      }
      const numeric = Number.parseInt(selection, 10);
      if (String(numeric) === selection && numeric >= 1 && numeric <= resumeChoices.length) {
        await loadThreadSessionById(resumeChoices[numeric - 1].thread_id);
        return;
      }
      const byNameOrId = resumeChoices.find(
        (thread) => thread.title === selection || thread.name === selection || thread.thread_id === selection,
      );
      if (byNameOrId) {
        await loadThreadSessionById(byNameOrId.thread_id);
        return;
      }
      if (selected) {
        await loadThreadSessionById(selected.thread_id);
        return;
      }
      await resumeThreadByName(selection);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      setTranscript((current) => [
        ...current,
        {id: nextTranscriptEntryId(), kind: "error", message},
      ]);
      setState(resumeChoices.length > 0 ? "resume-list" : threadId ? "completed" : "input");
    }
  }, [
    filteredResumeChoices,
    loadThreadSession,
    loadThreadSessionById,
    nextTranscriptEntryId,
    reply,
    resumeChoices,
    resumeThreadByName,
    selectedResumeIndex,
    threadId,
  ]);

  const renameCurrentThread = useCallback(
    async (name: string) => {
      const normalized = name.trim();
      if (!threadId) {
        setError("No active thread to rename");
        setState("input");
        return;
      }
      if (!normalized) {
        setError(null);
        setState("loading");
        try {
          client.initProject();
          const renamed = await client.autoRenameThread(threadId);
          setThreadId(renamed.thread_id);
          setSessionName(renamed.name ?? null);
          setTranscript((current) => [
            ...current,
            {
              id: nextTranscriptEntryId(),
              kind: "info",
              title: "Rename",
              content: `Session title updated to: ${renamed.name ?? renamed.thread_id}`,
            },
          ]);
          setState("completed");
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          setError(message);
          setState(threadId ? "completed" : "input");
        }
        return;
      }
      setError(null);
      setState("loading");
      try {
        client.initProject();
        const renamed = client.renameThread(threadId, {name: normalized});
        setThreadId(renamed.thread_id);
        setSessionName(renamed.name ?? null);
        setError(null);
        setState("completed");
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message);
        setState(threadId ? "completed" : "input");
      }
    },
    [client, nextTranscriptEntryId, threadId],
  );

  const showCurrentPlan = useCallback(async () => {
    if (!threadId) {
      setError("No active thread to inspect");
      setState("input");
      return;
    }
    setError(null);
    setState("loading");
    try {
      const plan = client.readThreadPlan(threadId);
      setSessionStatus(plan.session_status);
      setTranscript((current) => [
        ...current,
        {
          id: nextTranscriptEntryId(),
          kind: "info",
          title: "Current Idea Plan",
          content: currentPlanText(plan),
        },
      ]);
      setState("completed");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      setState(threadId ? "completed" : "input");
    }
  }, [client, nextTranscriptEntryId, threadId]);

  const showCurrentArtifact = useCallback(async () => {
    if (!threadId) {
      setError("No active thread to inspect");
      setState("input");
      return;
    }
    setError(null);
    setState("loading");
    try {
      const artifact = client.readThreadArtifact(threadId);
      setTranscript((current) => [
        ...current,
        {
          id: nextTranscriptEntryId(),
          kind: "info",
          title: "Current Artifact",
          content: artifactText(artifact),
        },
      ]);
      setState("completed");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      setState(threadId ? "completed" : "input");
    }
  }, [client, nextTranscriptEntryId, threadId]);

  const showThreadContext = useCallback(
    async (draft = "") => {
      if (!threadId) {
        setError("No active thread to inspect");
        setState("input");
        return;
      }
      setError(null);
      setState("loading");
      try {
        const query = draft.trim() ? `?draft=${encodeURIComponent(draft.trim())}` : "";
        const context = client.readThreadContext(threadId, draft.trim());
        setTranscript((current) => [
          ...current,
          {
            id: nextTranscriptEntryId(),
            kind: "info",
            title: "Artifact Context",
            content: contextText(context),
          },
        ]);
        setState("completed");
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message);
        setState(threadId ? "completed" : "input");
      }
    },
    [client, nextTranscriptEntryId, threadId],
  );

  const freezeCurrentPlan = useCallback(async () => {
    if (!threadId) {
      setError("No active thread to freeze");
      setState("input");
      return;
    }
    setError(null);
    setState("loading");
    try {
      const result = client.freezeThreadPlan(threadId);
      setSessionStatus("frozen");
      setTranscript((current) => [
        ...current,
        {
          id: nextTranscriptEntryId(),
          kind: "info",
          title: "Freeze",
          content: frozenPlanText(result),
        },
      ]);
      void refreshSessionStatus(threadId);
      setState("completed");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      setState(threadId ? "completed" : "input");
    }
  }, [client, nextTranscriptEntryId, refreshSessionStatus, threadId]);

  const reviewCurrentPlan = useCallback(
    async (value: string) => {
      if (!threadId) {
        setError("No active thread to review");
        setState("input");
        return;
      }
      const parsed = parseReviewCommandValue(value);
      if (!parsed) {
        setError("Usage: /review Reject|Revise|Advance|Provisional [notes]");
        setState(threadId ? "completed" : "input");
        return;
      }
      setError(null);
      setState("loading");
      try {
        const result = client.reviewThreadPlan(threadId, {
          decision: parsed.decision,
          notes: parsed.notes ?? null,
          scores: parsed.scores,
          confidence: parsed.confidence,
        });
        setSessionStatus(result.session_status);
        setTranscript((current) => [
          ...current,
          {
            id: nextTranscriptEntryId(),
            kind: "info",
            title: "Idea Review Gate",
            content: reviewText(result),
          },
        ]);
        void refreshSessionStatus(threadId);
        setState("completed");
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message);
        setState(threadId ? "completed" : "input");
      }
    },
    [client, nextTranscriptEntryId, refreshSessionStatus, threadId],
  );

  const showThreadStatus = useCallback(async () => {
    if (!threadId) {
      setError("No active thread");
      setState("input");
      return;
    }
    const thread = client.getThread(threadId);
    setTranscript((current) => [
      ...current,
      {
        id: nextTranscriptEntryId(),
        kind: "info",
        title: "Thread Status",
        content: [
          `mode: ${thread.current_mode ?? "idea_plan"}`,
          `lifecycle: ${thread.lifecycle_state ?? "lightweight_diagnosis"}`,
          `idea_version: ${thread.idea_version ?? 1}`,
          `impact: ${thread.impact_level ?? "None"}`,
        ].join("\n"),
      },
    ]);
    setState("completed");
  }, [client, nextTranscriptEntryId, threadId]);

  const showConvergence = useCallback(async () => {
    if (!threadId) {
      setError("No active thread");
      setState("input");
      return;
    }
    const status = client.threadConvergence(threadId);
    setTranscript((current) => [
      ...current,
      {id: nextTranscriptEntryId(), kind: "info", title: "Convergence", content: formatConvergence(status)},
    ]);
    setState("completed");
  }, [client, nextTranscriptEntryId, threadId]);

  const showPapers = useCallback(async () => {
    if (!threadId) {
      setError("No active thread");
      setState("input");
      return;
    }
    const papers = client.listThreadPapers(threadId);
    const lines = [
      "## Search Evidence",
      ...papers.evidence.map((e) => `- ${e.query} (${e.result_count} results)`),
      "## Local Manifest",
      ...papers.manifest_entries.map((e) => `- ${e.paper_id}: ${e.title} @ ${e.local_path}`),
      "## Mini Reviews",
      ...papers.mini_reviews.map((r) => `- ${r.title}`),
    ];
    setTranscript((current) => [
      ...current,
      {id: nextTranscriptEntryId(), kind: "info", title: "Papers", content: lines.join("\n") || "No papers yet."},
    ]);
    setState("completed");
  }, [client, nextTranscriptEntryId, threadId]);

  const runMetaReview = useCallback(async () => {
    if (!threadId) {
      setError("No active thread");
      setState("input");
      return;
    }
    const result = await client.triggerIdeaMetaReview(threadId);
    setTranscript((current) => [
      ...current,
      {
        id: nextTranscriptEntryId(),
        kind: "info",
        title: "AC Meta-review",
        content: `can_freeze=${String(result.meta_review.can_freeze)}\n${result.meta_review.evidence_summary}`,
      },
    ]);
    setState("completed");
  }, [client, nextTranscriptEntryId, threadId]);

  const startExperiment = useCallback(async () => {
    if (!threadId) {
      setError("No active thread");
      setState("input");
      return;
    }
    setError(null);
    setState("running");
    setStepCount(0);
    setActivities([]);
    setActivitiesExpanded(false);
    setAssistantDraft("");
    try {
      const response = await client.startExperimentDesignRun(
        threadId,
        "Continue experiment design from frozen plan.",
      );
      setRunId(response.run.run_id);
      const liveUi = createBatchedRunEventHandler({
        setActivities,
        setAssistantDraft,
        setStepCount,
      });
      const seenEvents: SSEEvent[] = [];
      try {
        await client.watchRunEvents(response.run.run_id, (event) => {
          seenEvents.push(event);
          liveUi.onEvent(event);
        });
      } finally {
        liveUi.flush();
        liveUi.dispose();
      }
      const runActivities = liveUi.getRunActivities();
      const finalRun = client.getRun(response.run.run_id);
      if (finalRun.status !== "completed") {
        throw new Error(`Experiment design run ${finalRun.status}: ${finalRun.error ?? "unknown error"}`);
      }
      const blueprint = client.readThreadBlueprint(threadId);
      setTranscript((current) => [
        ...current,
        {
          id: nextTranscriptEntryId(),
          kind: "info",
          title: "Experiment Design",
          content: blueprint.content.trim() || "Blueprint draft updated.",
        },
      ]);
      setAssistantDraft("");
      setActivities([]);
      setState("completed");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setState("completed");
    }
  }, [client, nextTranscriptEntryId, threadId]);

  const runExperimentMetaReview = useCallback(async () => {
    if (!threadId) {
      setError("No active thread");
      setState("input");
      return;
    }
    setError(null);
    setState("loading");
    try {
      const result = await client.triggerExperimentMetaReview(threadId);
      setTranscript((current) => [
        ...current,
        {
          id: nextTranscriptEntryId(),
          kind: "info",
          title: "Experiment AC Meta-review",
          content: `can_move_to_execution=${String(result.meta_review.can_move_to_execution)}\n${(result.meta_review.remaining_risks ?? []).join("; ")}`,
        },
      ]);
      setState("completed");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setState("completed");
    }
  }, [client, nextTranscriptEntryId, threadId]);

  const requestPaperReading = useCallback(
    async (value: string) => {
      if (!threadId) {
        setError("No active thread");
        setState("input");
        return;
      }
      const parsed = parseReadingCommandValue(value);
      if (!parsed || !parsed.paper_id) {
        setError("Usage: /read [quick|guided|exam] <paper_id> [query]");
        setState("completed");
        return;
      }
      client.setThreadReadingRequest(threadId, parsed);
      setTranscript((current) => [
        ...current,
        {
          id: nextTranscriptEntryId(),
          kind: "info",
          title: "Paper Reading",
          content: `Queued ${parsed.mode} reading for ${parsed.paper_id}. PaperReader runs on next plan turn.`,
        },
      ]);
      setState("completed");
    },
    [client, nextTranscriptEntryId, threadId],
  );

  const linkPaperEvidence = useCallback(
    async (evidenceId: string, paperId: string) => {
      if (!threadId) {
        setError("No active thread");
        setState("input");
        return;
      }
      const entry = client.linkThreadPaperEvidence(threadId, evidenceId.trim(), paperId.trim());
      setTranscript((current) => [
        ...current,
        {
          id: nextTranscriptEntryId(),
          kind: "info",
          title: "Paper Linked",
          content: `Linked evidence ${evidenceId} → ${entry.paper_id} (${entry.title})`,
        },
      ]);
      setState("completed");
    },
    [client, nextTranscriptEntryId, threadId],
  );

  const showHooks = useCallback(async () => {
    if (!threadId) return;
    const hooks = client.listThreadHooks(threadId);
    setTranscript((current) => [
      ...current,
      {
        id: nextTranscriptEntryId(),
        kind: "info",
        title: "Innovation Hooks",
        content: hooks.map((h) => `- ${h.title}`).join("\n") || "No hooks yet.",
      },
    ]);
    setState("completed");
  }, [client, nextTranscriptEntryId, threadId]);

  const showDisagreements = useCallback(async () => {
    if (!threadId) return;
    const logs = client.listThreadDisagreements(threadId);
    setTranscript((current) => [
      ...current,
      {
        id: nextTranscriptEntryId(),
        kind: "info",
        title: "Disagreements",
        content: logs.map((l) => `- ${l.title}`).join("\n") || "No disagreements logged.",
      },
    ]);
    setState("completed");
  }, [client, nextTranscriptEntryId, threadId]);

  const showVersion = useCallback(async () => {
    if (!threadId) return;
    const thread = client.getThread(threadId);
    setTranscript((current) => [
      ...current,
      {
        id: nextTranscriptEntryId(),
        kind: "info",
        title: "Idea Version",
        content: `version=${thread.idea_version} impact=${thread.impact_level ?? "None"}`,
      },
    ]);
    setState("completed");
  }, [client, nextTranscriptEntryId, threadId]);

  const registerPaper = useCallback(
    async (localPath: string) => {
      if (!threadId || !localPath.trim()) return;
      const entry = client.registerThreadPaper(threadId, localPath.trim());
      setTranscript((current) => [
        ...current,
        {
          id: nextTranscriptEntryId(),
          kind: "info",
          title: "Paper Registered",
          content: `${entry.paper_id}: ${entry.title}`,
        },
      ]);
      setState("completed");
    },
    [client, nextTranscriptEntryId, threadId],
  );

  const showBlueprint = useCallback(async () => {
    if (!threadId) return;
    const artifact = client.readThreadBlueprint(threadId);
    setTranscript((current) => [
      ...current,
      {
        id: nextTranscriptEntryId(),
        kind: "info",
        title: "Experiment Blueprint",
        content: artifact.content,
      },
    ]);
    setState("completed");
  }, [client, nextTranscriptEntryId, threadId]);

  const freezeBlueprint = useCallback(async () => {
    if (!threadId) return;
    const result = client.freezeThreadBlueprint(threadId);
    setTranscript((current) => [
      ...current,
      {
        id: nextTranscriptEntryId(),
        kind: "info",
        title: "Blueprint Frozen",
        content: result.blueprint.body.main_claim,
      },
    ]);
    setState("completed");
  }, [client, nextTranscriptEntryId, threadId]);

  const inspectCache = useCallback(async () => {
    setError(null);
    try {
      client.initProject();
      const response = client.listCache();
      const records = response.records ?? [];
      const content =
        records.length === 0
          ? "Cache is empty."
          : records
              .slice(0, 10)
              .map(
                (record) =>
                  [
                    record.cache_type,
                    `${record.profile}:${record.provider}/${record.model}`,
                    `input=${record.input_hash.slice(0, 12)}`,
                    record.created_at,
                  ].join(" | "),
              )
              .join("\n");
      setTranscript((current) => [
        ...current,
        {id: nextTranscriptEntryId(), kind: "info", title: "Cache", content},
      ]);
      setState(threadId ? "completed" : "input");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      setTranscript((current) => [
        ...current,
        {id: nextTranscriptEntryId(), kind: "error", message},
      ]);
      setState(threadId ? "completed" : "input");
    }
  }, [client, nextTranscriptEntryId, threadId]);

  const clearCache = useCallback(async () => {
    setError(null);
    try {
      client.initProject();
      const payload = client.clearCache();
      setTranscript((current) => [
        ...current,
        {
          id: nextTranscriptEntryId(),
          kind: "info",
          title: "Cache",
          content: `Deleted ${payload.deleted} app cache record(s).`,
        },
      ]);
      setState(threadId ? "completed" : "input");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      setTranscript((current) => [
        ...current,
        {id: nextTranscriptEntryId(), kind: "error", message},
      ]);
      setState(threadId ? "completed" : "input");
    }
  }, [client, nextTranscriptEntryId, threadId]);

  const resetToNewThread = useCallback(() => {
    activeRunAbortController.current?.abort();
    activeRunId.current = null;
    activeRunThreadId.current = null;
    activeRunSequence.current += 1;
    setIdea("");
    setReply("");
    setState("input");
    setStepCount(0);
    setActivities([]);
    setActivitiesExpanded(false);
    setAssistantDraft("");
    setRunId(null);
    setThreadId(null);
    setSessionName(null);
    setSessionStatus(null);
    setTranscript([]);
    setResumeChoices([]);
    setSelectedResumeIndex(0);
    setError(null);
    setContextUsage(null);
  }, []);

  const interruptCurrentRun = useCallback(async () => {
    const targetRunId = runId ?? activeRunId.current;
    const targetThreadId = threadId ?? activeRunThreadId.current;
    if (!targetRunId && !activeRunAbortController.current) {
      setError("No active run to interrupt yet.");
      return;
    }
    if (targetRunId) {
      interruptedRunIds.current.add(targetRunId);
    }
    activeRunAbortController.current?.abort();
    setError(null);
    setReply("");
    setState(targetThreadId ? "completed" : "input");
    setTranscript((current) => [
      ...current,
      {
        id: nextTranscriptEntryId(),
        kind: "info",
        title: "Interrupted",
        content: "Current run was interrupted locally. Backend cancellation was requested.",
      },
    ]);
    if (!targetRunId) {
      return;
    }
    try {
      client.cancelRun(targetRunId);
    } catch (caught) {
      const rawMessage = caught instanceof Error ? caught.message : String(caught);
      const message = interruptErrorMessage(rawMessage);
      setError(message);
    }
  }, [client, nextTranscriptEntryId, runId, threadId]);

  const runIdeaPlan = useCallback(
    async (content: string, existingThreadId?: string) => {
      const submittedContent = content.trim();
      const sequence = activeRunSequence.current + 1;
      activeRunSequence.current = sequence;
      const abortController = new AbortController();
      activeRunAbortController.current = abortController;
      activeRunId.current = null;
      activeRunThreadId.current = existingThreadId ?? threadId ?? null;
      const isCurrentRun = () =>
        activeRunSequence.current === sequence && !abortController.signal.aborted;
      const finishInterruptedRun = (targetThreadId: string | null) => {
        if (activeRunAbortController.current === abortController) {
          activeRunAbortController.current = null;
        }
        if (activeRunSequence.current === sequence) {
          activeRunId.current = null;
          activeRunThreadId.current = targetThreadId;
        }
        setReply("");
        setState(targetThreadId ? "completed" : "input");
      };
      try {
        setState("running");
        setStepCount(0);
        setActivities([]);
        setActivitiesExpanded(false);
        setAssistantDraft("");
        setRunId(null);
        setThreadId(existingThreadId ?? null);
        if (!existingThreadId) {
          setSessionName(null);
          setSessionStatus(null);
        }
        setError(null);
        setTranscript((current) => [
          ...current,
          {id: nextTranscriptEntryId(), kind: "message", role: "user", content: submittedContent},
        ]);
        client.initProject();
        const profiles = client.providerProfiles();
        if (!isCurrentRun()) {
          finishInterruptedRun(existingThreadId ?? threadId);
          return;
        }
        setProviderProfile(
          (profiles.profiles ?? []).find((profile) => profile.profile === "planner") ?? null,
        );
        const response = existingThreadId
          ? await client.continueIdeaPlanThread(existingThreadId, {content: content.trim()})
          : await client.startIdeaPlanRun({idea: content.trim()});
        if (!isCurrentRun()) {
          interruptedRunIds.current.add(response.run.run_id);
          activeRunId.current = response.run.run_id;
          activeRunThreadId.current = response.run.thread_id;
          void client.cancelRun(response.run.run_id);
          finishInterruptedRun(response.run.thread_id);
          return;
        }
        activeRunId.current = response.run.run_id;
        activeRunThreadId.current = response.run.thread_id;
        setRunId(response.run.run_id);
        setThreadId(response.run.thread_id);
        const seenEvents: SSEEvent[] = [];
        const liveUi = createBatchedRunEventHandler({
          setActivities,
          setAssistantDraft,
          setStepCount,
        });
        try {
          await client.watchRunEvents(response.run.run_id, (event) => {
            if (
              !isCurrentRun() ||
              interruptedRunIds.current.has(response.run.run_id)
            ) {
              return;
            }
            seenEvents.push(event);
            liveUi.onEvent(event);
          }, abortController.signal);
        } finally {
          liveUi.flush();
          liveUi.dispose();
        }
        const runActivities = liveUi.getRunActivities();
        if (
          !isCurrentRun() ||
          interruptedRunIds.current.has(response.run.run_id)
        ) {
          finishInterruptedRun(response.run.thread_id);
          return;
        }
        const finalRun = client.getRun(response.run.run_id);
        if (
          finalRun.status !== "completed" ||
          interruptedRunIds.current.has(response.run.run_id) ||
          seenEvents.some((event) => event.event_type === "run.cancelled")
        ) {
          setRunId(finalRun.run_id);
          setThreadId(finalRun.thread_id);
          finishInterruptedRun(finalRun.thread_id);
          return;
        }
        const finalResult = loadCompletedRunResult(
          client,
          response.run.run_id,
          response.run.thread_id,
        );
        if (
          !isCurrentRun() ||
          interruptedRunIds.current.has(response.run.run_id)
        ) {
          finishInterruptedRun(response.run.thread_id);
          return;
        }
        setThreadId(finalResult.thread.thread_id);
        setSessionName(finalResult.thread.name ?? null);
        void refreshSessionStatus(finalResult.thread.thread_id);
        const mergedActivityHistory = {
          ...activityHistoryRef.current,
          [response.run.run_id]: {
            activities: runActivities,
            stepCount: runActivities.length,
          },
        };
        activityHistoryRef.current = mergedActivityHistory;
        setTranscript(
          transcriptFromMessagesWithActivity(finalResult.messages ?? [], mergedActivityHistory),
        );
        void refreshContextUsage(finalResult.thread.thread_id, "");
        setAssistantDraft("");
        setActivities([]);
        setReply("");
        setState("completed");
        if (activeRunAbortController.current === abortController) {
          activeRunAbortController.current = null;
        }
        if (activeRunSequence.current === sequence) {
          activeRunId.current = null;
          activeRunThreadId.current = finalResult.thread.thread_id;
        }
        if (args.once || (args.idea && !inputEnabled)) {
          setTimeout(() => exit(), 100);
        }
      } catch (caught) {
        if (isAbortError(caught)) {
          finishInterruptedRun(threadId);
          return;
        }
        const message = caught instanceof Error ? caught.message : String(caught);
        if (isRunNotCompletedError(message)) {
          finishInterruptedRun(threadId);
          return;
        }
        if (isConfigurationRequired(caught)) {
          openSetupWizard();
          return;
        }
        setError(message);
        setTranscript((current) => [
          ...current,
          {id: nextTranscriptEntryId(), kind: "error", message},
        ]);
        setState(threadId ? "completed" : "input");
        if (activeRunAbortController.current === abortController) {
          activeRunAbortController.current = null;
        }
        if (activeRunSequence.current === sequence) {
          activeRunId.current = null;
        }
      }
    },
    [
      client,
      args.idea,
      args.once,
      exit,
      inputEnabled,
      nextTranscriptEntryId,
      openSetupWizard,
      refreshContextUsage,
      refreshSessionStatus,
      threadId,
    ],
  );

  const submitCommand = useCallback(
    async (raw: string, source: "idea" | "reply") => {
      const command = parseSlashCommand(raw);
      if (!command) {
        return false;
      }
      if (command.command === "quit") {
        exit();
      } else if (command.command === "config") {
        openSetupWizard();
      } else if (command.command === "new") {
        const newIdea = command.value.trim();
        resetToNewThread();
        if (newIdea) {
          await runIdeaPlan(newIdea);
        }
      } else if (command.command === "resume") {
        if (command.value.trim()) {
          await resumeThreadByName(command.value);
        } else {
          await showResumeList();
        }
      } else if (command.command === "rename") {
        await renameCurrentThread(command.value);
      } else if (command.command === "plan") {
        await showCurrentPlan();
      } else if (command.command === "artifact") {
        await showCurrentArtifact();
      } else if (command.command === "context") {
        await showThreadContext(command.value);
      } else if (command.command === "freeze") {
        await freezeCurrentPlan();
      } else if (command.command === "review") {
        await reviewCurrentPlan(command.value);
      } else if (command.command === "status") {
        await showThreadStatus();
      } else if (command.command === "convergence") {
        await showConvergence();
      } else if (command.command === "papers") {
        const value = command.value.trim();
        if (value.startsWith("add ")) {
          await registerPaper(value.slice(4));
        } else if (value.startsWith("link ")) {
          const [, evidenceId, paperId] = value.split(/\s+/);
          if (!evidenceId || !paperId) {
            setError("Usage: /papers link <evidence_artifact_id> <paper_id>");
            setState("completed");
          } else {
            await linkPaperEvidence(evidenceId, paperId);
          }
        } else {
          await showPapers();
        }
      } else if (command.command === "hooks") {
        await showHooks();
      } else if (command.command === "disagreements") {
        await showDisagreements();
      } else if (command.command === "version") {
        await showVersion();
      } else if (command.command === "blueprint") {
        await showBlueprint();
      } else if (command.command === "freeze-blueprint") {
        await freezeBlueprint();
      } else if (command.command === "review-blueprint") {
        if (threadId) {
          client.reviewThreadBlueprint(threadId, command.value || "Revise");
          setState("completed");
        }
      } else if (command.command === "back-to-plan") {
        if (threadId) {
          const thread = client.switchThreadToIdeaPlan(threadId);
          setTranscript((current) => [
            ...current,
            {
              id: nextTranscriptEntryId(),
              kind: "info",
              title: "Mode",
              content: `Switched to Idea Plan mode (current_mode=${thread.current_mode}).`,
            },
          ]);
          setState("completed");
        }
      } else if (command.command === "read") {
        await requestPaperReading(command.value);
      } else if (command.command === "meta-review") {
        await runMetaReview();
      } else if (command.command === "meta-review-blueprint") {
        await runExperimentMetaReview();
      } else if (command.command === "experiment") {
        await startExperiment();
      } else if (command.command === "pause") {
        if (threadId) client.pauseThread(threadId, command.value || null);
        setState("completed");
      } else if (command.command === "cache") {
        await inspectCache();
      } else {
        await clearCache();
      }
      if (source === "idea") {
        setIdea("");
      } else {
        setReply("");
      }
      return true;
    },
    [
      clearCache,
      exit,
      freezeCurrentPlan,
      inspectCache,
      openSetupWizard,
      renameCurrentThread,
      reviewCurrentPlan,
      resetToNewThread,
      resumeThreadByName,
      runMetaReview,
      runIdeaPlan,
      showConvergence,
      showCurrentArtifact,
      showCurrentPlan,
      showPapers,
      showHooks,
      showDisagreements,
      showVersion,
      registerPaper,
      showBlueprint,
      freezeBlueprint,
      showThreadContext,
      showThreadStatus,
      showResumeList,
      startExperiment,
      runExperimentMetaReview,
      requestPaperReading,
      linkPaperEvidence,
      client,
      threadId,
    ],
  );

  useEffect(() => {
    if (!setupConfigured || initialCommandHandled.current) {
      return;
    }
    if (args.resume) {
      initialCommandHandled.current = true;
      void resumeThreadByName(args.resume);
      return;
    }
    if (args.resumeList) {
      initialCommandHandled.current = true;
      void showResumeList();
      return;
    }
    if (args.idea) {
      initialCommandHandled.current = true;
      void runIdeaPlan(args.idea);
    }
  }, [args.idea, args.resume, args.resumeList, resumeThreadByName, runIdeaPlan, setupConfigured, showResumeList]);

  useInput(
    (input, key) => {
      if (state === "setup" || state === "setup-loading") {
        return;
      }
      if (key.ctrl && input === "c") {
        setError("Use /quit to exit.");
        return;
      }
      if (key.escape && (state === "loading" || state === "running")) {
        void interruptCurrentRun();
        return;
      }
      if (state === "running" && input === "e") {
        setActivitiesExpanded((current) => !current);
        return;
      }
      if (state === "completed" && input === "e") {
        setActivitiesExpanded((current) => !current);
        return;
      }
      if (state === "loading") {
        return;
      }
      if (state === "running") {
        return;
      }
      if (state === "error") {
        return;
      }
      if (state === "resume-list") {
        if (key.escape) {
          setState(threadId ? "completed" : "input");
          return;
        }
        if (key.upArrow || input === "k") {
          setSelectedResumeIndex((current) =>
            filteredResumeChoices.length === 0
              ? 0
              : (current - 1 + filteredResumeChoices.length) % filteredResumeChoices.length,
          );
          return;
        }
        if (key.downArrow || input === "j") {
          setSelectedResumeIndex((current) =>
            filteredResumeChoices.length === 0
              ? 0
              : (current + 1) % filteredResumeChoices.length,
          );
          return;
        }
        if (key.return) {
          const maybeCommand = parseSlashCommand(reply);
          if (maybeCommand) {
            void submitCommand(reply, "reply");
            return;
          }
          void resumeSelectedThread();
          return;
        }
        if (key.backspace || key.delete) {
          setReply((current) => current.slice(0, -1));
          return;
        }
        if (input.length > 0 && !key.ctrl && !key.meta) {
          setReply((current) => `${current}${input}`);
        }
        return;
      }
      if (state === "completed") {
        if (key.return) {
          if (canReply) {
            const maybeCommand = parseSlashCommand(reply);
            if (maybeCommand) {
              void submitCommand(reply, "reply");
            } else if (threadId) {
              void runIdeaPlan(reply, threadId);
            }
          }
          return;
        }
        if (key.tab && activeSlashSuggestion) {
          setReply(activeSlashSuggestion);
          return;
        }
        if (key.backspace || key.delete) {
          setReply((current) => current.slice(0, -1));
          return;
        }
        if (input.length > 0 && !key.ctrl && !key.meta) {
          setReply((current) => `${current}${input}`);
        }
        return;
      }
      if (state === "input") {
        if (key.return) {
          if (canSubmit) {
            const maybeCommand = parseSlashCommand(idea);
            if (maybeCommand) {
              void submitCommand(idea, "idea");
            } else {
              void runIdeaPlan(idea);
            }
          }
          return;
        }
        if (key.tab && activeSlashSuggestion) {
          setIdea(activeSlashSuggestion);
          return;
        }
        if (key.backspace || key.delete) {
          setIdea((current) => current.slice(0, -1));
          return;
        }
        if (input.length > 0 && !key.ctrl && !key.meta) {
          setIdea((current) => `${current}${input}`);
        }
      }
    },
    {isActive: inputEnabled},
  );

  const inSetup = state === "setup" || state === "setup-loading";

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">
        Academic Agent v0
      </Text>
      <Text color="gray">Project: {args.projectRoot}</Text>
      {providerProfile ? (
        <Text color="gray">
          Planner: {providerProfile.provider}/{providerProfile.model}
          {providerProfile.will_use_live ? " live" : " configuration required"}
          {providerProfile.reasoning_effort
            ? ` reasoning=${providerProfile.reasoning_effort}`
            : ""}
        </Text>
      ) : setupConfigured ? null : (
        <Text color="yellow">Configuration required</Text>
      )}

      {state === "setup-loading" && <Text color="gray">Loading setup...</Text>}
      {state === "setup" && setupStatus && (
        <SetupWizard
          client={client}
          initialStatus={setupStatus}
          reconfigure={setupMode === "reconfigure"}
          onComplete={handleSetupComplete}
          onDismiss={dismissSetupWizard}
          onCancel={() => {
            if (setupMode === "reconfigure") {
              dismissSetupWizard();
              return;
            }
            exit();
          }}
        />
      )}

      {!inSetup && threadId && setupConfigured && (
        <Text color="gray">
          Session: {sessionName ? `${sessionName} (${threadId})` : threadId}
          {sessionStatus ? ` · plan=${sessionStatus}` : ""}
        </Text>
      )}

      {!inSetup && setupConfigured && visibleTranscript.entries.length > 0 && (
        <Box flexDirection="column" gap={1}>
          {visibleTranscript.hiddenCount > 0 && (
            <Text color="gray">
              Showing latest {visibleTranscript.entries.length} transcript item(s) while working;{" "}
              {visibleTranscript.hiddenCount} earlier item(s) are hidden until this run finishes.
            </Text>
          )}
          {visibleTranscript.entries.map((entry) => (
            <TranscriptEntryView
              key={entry.id}
              entry={entry}
              activitiesExpanded={activitiesExpanded}
            />
          ))}
        </Box>
      )}

      {!inSetup && setupConfigured && state === "input" && (
        <Box flexDirection="column">
          <Text>Research idea:</Text>
          <Text color={canSubmit ? "white" : "gray"}>
            {idea}
            <Text color="cyan">█</Text>
          </Text>
          {activeSlashSuggestion && <SlashSuggestionView suggestion={activeSlashSuggestion} />}
          <ContextUsageLine usage={activeContextUsage} />
          <Text color="gray">Press Enter to create an Idea Plan run. Use /quit to exit.</Text>
        </Box>
      )}

      {!inSetup && setupConfigured && state === "loading" && (
        <WorkingStatusWithClock label={workingLabel} startedAt={workingStartedAt} />
      )}

      {!inSetup && setupConfigured && state === "resume-list" && (
        <Box flexDirection="column">
          <Text bold>Resume session</Text>
          {filteredResumeChoices.length === 0 && (
            <Text color="yellow">No matching sessions.</Text>
          )}
          {filteredResumeChoices.map((thread, index) => (
            <ResumeSessionRow
              key={thread.thread_id}
              thread={thread}
              selected={index === selectedResumeIndex}
              now={clockNow}
            />
          ))}
          <Text color="gray">Use ↑/↓ or j/k, Enter to resume. Newest sessions are at the bottom.</Text>
          <Text color="gray">Type to filter by title/name/id.</Text>
          <Text color={canReply ? "white" : "gray"}>
            {reply}
            <Text color="cyan">█</Text>
          </Text>
          <Text color="gray">Press Enter to resume, Esc to close the list, or /quit to exit.</Text>
        </Box>
      )}

      {!inSetup && setupConfigured && (state === "running" || state === "error") && (
        <Box flexDirection="column">
          {state === "running" ? (
            <WorkingStatusWithClock label={workingLabel} startedAt={workingStartedAt} />
          ) : (
            <Text>
              Status: <Text color="red">error</Text>
            </Text>
          )}
          <ContextUsageLine usage={activeContextUsage} />
          {runId && <Text color="gray">Run: {runId}</Text>}
          {threadId && (
            <Text color="gray">
              Thread: {sessionName ? `${sessionName} (${threadId})` : threadId}
            </Text>
          )}
          <ActivityStream
            activities={activities}
            assistantDraft={assistantDraft}
            stepCount={stepCount}
            expanded={activitiesExpanded}
          />
          <Text color="gray">按 e 展开/收起事件流 · Esc 中断当前 run</Text>
        </Box>
      )}

      {!inSetup && setupConfigured && state === "completed" && threadId && (
        <Box flexDirection="column">
          {inputEnabled ? (
            <Box flexDirection="column">
              <Text>Continue this thread:</Text>
              <Text color={canReply ? "white" : "gray"}>
                {reply}
                <Text color="cyan">█</Text>
              </Text>
              {activeSlashSuggestion && <SlashSuggestionView suggestion={activeSlashSuggestion} />}
              <ContextUsageLine usage={activeContextUsage} />
              <Text color="gray">Press Enter to continue. Use /quit to exit.</Text>
            </Box>
          ) : (
            <Text color="gray">Run in an interactive terminal to continue this thread.</Text>
          )}
        </Box>
      )}

      {error && <Text color="red">Error: {error}</Text>}
    </Box>
  );
};

const TranscriptEntryView = ({
  entry,
  activitiesExpanded,
}: {
  entry: TranscriptEntry;
  activitiesExpanded: boolean;
}) => {
  if (entry.kind === "message") {
    const isUser = entry.role === "user";
    return (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={isUser ? "cyan" : "green"}
        paddingX={1}
      >
        <Text bold color={isUser ? "cyan" : "green"}>
          {isUser ? "You" : "Academic Agent"}
        </Text>
        <Text>{entry.content}</Text>
      </Box>
    );
  }

  if (entry.kind === "error") {
    return (
      <Box flexDirection="column">
        <Text bold color="red">
          Error
        </Text>
        <Text color="red">{entry.message}</Text>
      </Box>
    );
  }

  if (entry.kind === "activity") {
    return (
      <ActivityBlock
        title={entry.title}
        activities={entry.activities}
        stepCount={entry.stepCount}
        expanded={activitiesExpanded}
      />
    );
  }

  if (entry.kind === "info") {
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">
          {entry.title}
        </Text>
        <Text color="gray">{entry.content}</Text>
      </Box>
    );
  }

  return null;
};

const ContextUsageLine = ({usage}: {usage: ContextUsageResponse | null}) => {
  if (!usage) {
    return <Text color="gray">Context: calculating...</Text>;
  }
  const contextPercent = Math.round(usage.usage_ratio * 100);
  const thresholdPercent = Math.round(usage.threshold_ratio * 100);
  const color = usage.should_compact ? "yellow" : contextPercent >= 80 ? "yellow" : "gray";
  return (
    <Text color={color}>
      Context: ~{formatTokenCount(usage.estimated_total_tokens)} tokens
      {usage.estimated_draft_tokens > 0 || usage.estimated_artifact_tokens > 0
        ? ` (${formatTokenCount(usage.estimated_thread_tokens)} history + ${formatTokenCount(usage.estimated_artifact_tokens)} memory + ${formatTokenCount(usage.estimated_draft_tokens)} draft)`
        : ""}{" "}
      · window {formatTokenCount(usage.context_window_tokens)} · compact threshold{" "}
      {formatTokenCount(usage.compact_threshold_tokens)} history tokens ({thresholdPercent}%)
      {usage.artifact_source_count > 0 ? ` · memory refs ${usage.artifact_source_count}` : ""}
      {usage.should_compact ? " · will compact next run" : ""}
    </Text>
  );
};

const ActivityBlock = memo(function ActivityBlock({
  title,
  activities,
  stepCount,
  expanded,
}: {
  title: string;
  activities: ActivityEntry[];
  stepCount: number;
  expanded: boolean;
}) {
  const shown = visibleActivities(activities, expanded);
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        {title}
      </Text>
      {shown.map((activity) => (
        <ActivityLine key={activity.id} activity={activity} />
      ))}
      <Text color="gray">
        {activityStreamFooter(activities, expanded) || `共 ${stepCount} 步`}
      </Text>
    </Box>
  );
});

const ActivityStream = memo(function ActivityStream({
  activities,
  assistantDraft,
  stepCount,
  expanded,
}: {
  activities: ActivityEntry[];
  assistantDraft: string;
  stepCount: number;
  expanded: boolean;
}) {
  const shown = visibleActivities(activities, expanded);
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold color="yellow">
          Working
        </Text>
        {shown.length === 0 ? (
          <Text color="gray">Preparing local run...</Text>
        ) : (
          shown.map((activity) => <ActivityLine key={activity.id} activity={activity} />)
        )}
        <Text color="gray">
          {activityStreamFooter(activities, expanded) || (stepCount > 0 ? `共 ${stepCount} 步` : "")}
        </Text>
      </Box>
      {assistantDraft.length > 0 && (
        <Box flexDirection="column" borderStyle="single" borderColor="green" paddingX={1}>
          <Text bold color="green">
            Academic Agent
          </Text>
          <Text>{assistantDraft}</Text>
        </Box>
      )}
    </Box>
  );
});

const ActivityLine = memo(function ActivityLine({activity}: {activity: ActivityEntry}) {
  const stageLabel = STAGE_LABELS[activity.stage] ?? activity.stage;
  const color =
    activity.status === "completed"
      ? "green"
      : activity.status === "error"
        ? "red"
        : activity.status === "started"
          ? "cyan"
          : "yellow";
  const marker =
    activity.status === "completed"
      ? "✓"
      : activity.status === "error"
        ? "!"
        : activity.status === "started"
          ? "→"
          : "•";
  return (
    <Text>
      <Text color={color}>{marker}</Text>{" "}
      <Text color="gray">{stageLabel}</Text>{" "}
      <Text>{activity.message}</Text>
    </Text>
  );
});

const WorkingStatusWithClock = memo(function WorkingStatusWithClock({
  label,
  startedAt,
}: {
  label: string;
  startedAt: number | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (startedAt === null) {
      return;
    }
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return <WorkingStatus label={label} startedAt={startedAt} now={now} />;
});

const WorkingStatus = ({
  label,
  startedAt,
  now,
}: {
  label: string;
  startedAt: number | null;
  now: number;
}) => (
  <Text>
    Status: <Text color="green">working</Text>{" "}
    <Text color="cyan">{formatElapsed(startedAt ? now - startedAt : 0)}</Text>{" "}
    <Text color="gray">({label})</Text>
  </Text>
);

const SlashSuggestionView = ({suggestion}: {suggestion: string}) => (
  <Text color="gray">
    suggestion: <Text color="cyan">{suggestion}</Text> <Text color="gray">Tab to accept</Text>
  </Text>
);

const ResumeSessionRow = ({
  thread,
  selected,
  now,
}: {
  thread: ThreadSessionSummary;
  selected: boolean;
  now: number;
}) => (
  <Box flexDirection="column">
    <Text color={selected ? "cyan" : "white"}>
      {selected ? "›" : " "} {thread.title}
    </Text>
    <Text color="gray">
      {"  "}创建 {formatAbsoluteTime(thread.created_at)} · 更新{" "}
      {formatRelativeTime(thread.updated_at, now)} · {thread.message_count} messages ·{" "}
      {thread.latest_status ?? "unknown"} · plan {thread.session_status ?? "unknown"}
    </Text>
  </Box>
);

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  const commands = helpText();
  process.stdout.write(
    "Usage: academic-agent [resume [NAME]|--resume [NAME]] [--project-root PATH] [--idea TEXT] [--once]\n" +
      `Commands: ${commands}\n` +
      "Keys: Esc interrupts the current run.\n",
  );
  process.exit(0);
}

render(<App args={args} />);
