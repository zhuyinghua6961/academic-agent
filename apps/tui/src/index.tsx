#!/usr/bin/env node
import React, {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {Box, Text, render, useApp, useInput} from "ink";
import type {
  AppCacheClearResponse,
  AppCacheListResponse,
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
} from "@academic-agent/schemas";

type Args = {
  coreUrl: string;
  idea?: string;
  resume?: string;
  resumeList: boolean;
  help: boolean;
  once: boolean;
};

type UiState = "input" | "loading" | "running" | "completed" | "resume-list" | "error";
type SlashCommand =
  | "new"
  | "resume"
  | "rename"
  | "plan"
  | "freeze"
  | "review"
  | "cache"
  | "clear-cache"
  | "quit";

type TranscriptEntry =
  | {id: string; kind: "message"; role: ThreadMessage["role"]; content: string; runId?: string | null}
  | {id: string; kind: "activity"; title: string; activities: ActivityEntry[]; eventCount: number}
  | {id: string; kind: "info"; title: string; content: string}
  | {id: string; kind: "error"; message: string};

type ActivityEntry = {
  id: string;
  stage: string;
  status: "started" | "updated" | "completed" | "error";
  message: string;
  createdAt: string;
};

type ThreadSessionLike = Partial<ThreadSessionSummary> & Partial<WorkflowThread>;

const LIVE_UI_FLUSH_MS = 80;
const WORKING_TRANSCRIPT_LIMIT = 4;

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    coreUrl: process.env.ACADEMIC_AGENT_CORE_URL ?? "http://127.0.0.1:8765",
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
    } else if (arg === "--core-url") {
      args.coreUrl = argv[index + 1] ?? args.coreUrl;
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

const postJson = async <T,>(
  url: string,
  body: unknown,
  init: Pick<RequestInit, "signal"> = {},
): Promise<T> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify(body),
    signal: init.signal,
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return (await response.json()) as T;
};

const getJson = async <T,>(
  url: string,
  init: Pick<RequestInit, "signal"> = {},
): Promise<T> => {
  const response = await fetch(url, {signal: init.signal});
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return (await response.json()) as T;
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

const readSseEvents = async (
  url: string,
  onEvent: (event: SSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> => {
  const response = await fetch(url, {signal});
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      return;
    }
    const {done, value} = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, {stream: true});
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (data.length > 0) {
        onEvent(JSON.parse(data) as SSEEvent);
      }
    }
  }
};

const transcriptFromMessagesWithActivity = (
  messages: ThreadMessage[],
  activityHistory: Record<string, {activities: ActivityEntry[]; eventCount: number}>,
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
        title: "Working trace",
        activities: runActivity.activities,
        eventCount: runActivity.eventCount,
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

const activityFromEvent = (event: SSEEvent): ActivityEntry | null => {
  if (!event.event_type.startsWith("activity.")) {
    if (event.event_type === "run.failed") {
      return {
        id: event.event_id,
        stage: "error",
        status: "error",
        message: String(event.payload?.error ?? "Run failed."),
        createdAt: event.created_at,
      };
    }
    if (event.event_type === "paper_search.evidence.created") {
      const query = String(event.payload?.query ?? "paper search");
      const resultCount = Number(event.payload?.result_count ?? 0);
      const path = String(event.payload?.path ?? "");
      return {
        id: event.event_id,
        stage: "evidence",
        status: "completed",
        message: `已保存 paper search evidence：${query} (${resultCount} results)${path ? ` · ${path}` : ""}`,
        createdAt: event.created_at,
      };
    }
    if (event.event_type === "paper_search.evidence.failed") {
      return {
        id: event.event_id,
        stage: "evidence",
        status: "error",
        message: `paper search evidence 保存失败：${String(event.payload?.error ?? "unknown error")}`,
        createdAt: event.created_at,
      };
    }
    return null;
  }

  const status = event.event_type.replace("activity.", "");
  const allowedStatuses = new Set(["started", "updated", "completed"]);
  return {
    id: event.event_id,
    stage: String(event.payload?.stage ?? "working"),
    status: allowedStatuses.has(status)
      ? (status as ActivityEntry["status"])
      : "updated",
    message: String(event.payload?.message ?? event.event_type),
    createdAt: event.created_at,
  };
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

const SLASH_COMMANDS: SlashCommand[] = [
  "new",
  "resume",
  "rename",
  "plan",
  "freeze",
  "review",
  "cache",
  "clear-cache",
  "quit",
];

const parseSlashCommand = (
  input: string,
): {command: SlashCommand; value: string} | null => {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const [rawCommand, ...rest] = trimmed.slice(1).split(/\s+/);
  const command = rawCommand.toLowerCase() as SlashCommand;
  if (!SLASH_COMMANDS.includes(command)) {
    return null;
  }
  return {command, value: rest.join(" ").trim()};
};

const slashSuggestion = (input: string): string | null => {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/") || trimmed.includes(" ")) {
    return null;
  }
  const fragment = trimmed.slice(1).toLowerCase();
  if (!fragment) {
    return null;
  }
  const match = SLASH_COMMANDS.find((command) => command.startsWith(fragment));
  return match && match !== fragment ? `/${match}` : null;
};

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
): {decision: "Reject" | "Revise" | "Advance"; notes: string | null} | null => {
  const [rawDecision, ...rest] = value.trim().split(/\s+/);
  const normalized = rawDecision?.toLowerCase();
  const decision =
    normalized === "reject"
      ? "Reject"
      : normalized === "revise"
        ? "Revise"
        : normalized === "advance"
          ? "Advance"
          : null;
  if (!decision) {
    return null;
  }
  const notes = rest.join(" ").trim();
  return {decision, notes: notes.length > 0 ? notes : null};
};

const reviewText = (response: ReviewIdeaPlanResponse): string =>
  [
    `Decision: ${response.decision}`,
    `Session status: ${response.session_status}`,
    response.notes ? `Notes: ${response.notes}` : "Notes: none",
  ].join("\n");

const App = ({args}: {args: Args}) => {
  const {exit} = useApp();
  const transcriptEntryId = useRef(0);
  const initialCommandHandled = useRef(false);
  const activeRunAbortController = useRef<AbortController | null>(null);
  const activeRunId = useRef<string | null>(null);
  const activeRunThreadId = useRef<string | null>(null);
  const activeRunSequence = useRef(0);
  const interruptedRunIds = useRef<Set<string>>(new Set());
  const activityHistoryRef = useRef<Record<string, {activities: ActivityEntry[]; eventCount: number}>>({});
  const [idea, setIdea] = useState(args.idea ?? "");
  const [reply, setReply] = useState("");
  const [state, setState] = useState<UiState>(
    args.resume || args.resumeList ? "loading" : args.idea ? "running" : "input",
  );
  const [eventCount, setEventCount] = useState(0);
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
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
        const url = targetThreadId
          ? `${args.coreUrl}/threads/${targetThreadId}/context-usage${query}`
          : `${args.coreUrl}/context-usage${query}`;
        const usage = await getJson<ContextUsageResponse>(url);
        setContextUsage(usage);
      } catch {
        // Context usage is informational; do not block the main TUI when core is booting.
      }
    },
    [args.coreUrl, threadId],
  );

  const refreshSessionStatus = useCallback(
    async (targetThreadId: string | null = threadId): Promise<CurrentIdeaPlanResponse | null> => {
      if (!targetThreadId) {
        setSessionStatus(null);
        return null;
      }
      try {
        const plan = await getJson<CurrentIdeaPlanResponse>(
          `${args.coreUrl}/threads/${targetThreadId}/plan`,
        );
        setSessionStatus(plan.session_status);
        return plan;
      } catch {
        setSessionStatus(null);
        return null;
      }
    },
    [args.coreUrl, threadId],
  );

  useEffect(() => {
    if (!isWorking) {
      setWorkingStartedAt(null);
      return;
    }

    setWorkingStartedAt((current) => current ?? Date.now());
    setClockNow(Date.now());
    const timer = setInterval(() => {
      setClockNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [isWorking]);

  useEffect(() => {
    void refreshContextUsage(threadId, "");
  }, [refreshContextUsage, threadId]);

  useEffect(() => {
    void refreshSessionStatus(threadId);
  }, [refreshSessionStatus, threadId]);

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
      const messagesResponse = await getJson<ThreadMessagesResponse>(
        `${args.coreUrl}/threads/${thread.thread_id}/messages`,
      );
      const messages = messagesResponse.messages ?? [];
      setThreadId(messagesResponse.thread.thread_id);
      setSessionName(messagesResponse.thread.name ?? null);
      setTranscript(transcriptFromMessagesWithActivity(messages, activityHistoryRef.current));
      void refreshContextUsage(messagesResponse.thread.thread_id, "");
      void refreshSessionStatus(messagesResponse.thread.thread_id);
      setRunId(null);
      setEventCount(0);
      setActivities([]);
      setAssistantDraft("");
      setError(null);
      setReply("");
      setIdea("");

      setState("completed");
    },
    [args.coreUrl, refreshContextUsage, refreshSessionStatus],
  );

  const loadThreadSessionById = useCallback(
    async (targetThreadId: string) => {
      const thread = await getJson<WorkflowThread>(`${args.coreUrl}/threads/${targetThreadId}`);
      await loadThreadSession(thread);
    },
    [args.coreUrl, loadThreadSession],
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
        await postJson(`${args.coreUrl}/projects/init`, {});
        const thread = await getJson<WorkflowThread>(
          `${args.coreUrl}/threads/by-name/${encodeURIComponent(normalized)}`,
        );
        await loadThreadSession(thread);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message);
        setState(threadId ? "completed" : "input");
      }
    },
    [args.coreUrl, loadThreadSession, threadId],
  );

  const showResumeList = useCallback(async () => {
    setError(null);
    setReply("");
    setState("loading");
    try {
      await postJson(`${args.coreUrl}/projects/init`, {});
      const response = await getJson<ThreadListResponse>(`${args.coreUrl}/threads`);
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
  }, [args.coreUrl, nextTranscriptEntryId, threadId]);

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
          await postJson(`${args.coreUrl}/projects/init`, {});
          const renamed = await postJson<WorkflowThread>(
            `${args.coreUrl}/threads/${threadId}/rename-auto`,
            {},
          );
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
        await postJson(`${args.coreUrl}/projects/init`, {});
        const renamed = await postJson<WorkflowThread>(
          `${args.coreUrl}/threads/${threadId}/rename`,
          {name: normalized},
        );
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
    [args.coreUrl, nextTranscriptEntryId, threadId],
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
      const plan = await getJson<CurrentIdeaPlanResponse>(
        `${args.coreUrl}/threads/${threadId}/plan`,
      );
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
  }, [args.coreUrl, nextTranscriptEntryId, threadId]);

  const freezeCurrentPlan = useCallback(async () => {
    if (!threadId) {
      setError("No active thread to freeze");
      setState("input");
      return;
    }
    setError(null);
    setState("loading");
    try {
      const result = await postJson<FreezeIdeaPlanResponse>(
        `${args.coreUrl}/threads/${threadId}/freeze`,
        {},
      );
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
  }, [args.coreUrl, nextTranscriptEntryId, refreshSessionStatus, threadId]);

  const reviewCurrentPlan = useCallback(
    async (value: string) => {
      if (!threadId) {
        setError("No active thread to review");
        setState("input");
        return;
      }
      const parsed = parseReviewCommandValue(value);
      if (!parsed) {
        setError("Usage: /review Reject|Revise|Advance [notes]");
        setState(threadId ? "completed" : "input");
        return;
      }
      setError(null);
      setState("loading");
      try {
        const result = await postJson<ReviewIdeaPlanResponse>(
          `${args.coreUrl}/threads/${threadId}/review`,
          parsed,
        );
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
    [args.coreUrl, nextTranscriptEntryId, refreshSessionStatus, threadId],
  );

  const inspectCache = useCallback(async () => {
    setError(null);
    try {
      await postJson(`${args.coreUrl}/projects/init`, {});
      const response = await getJson<AppCacheListResponse>(`${args.coreUrl}/cache`);
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
  }, [args.coreUrl, nextTranscriptEntryId, threadId]);

  const clearCache = useCallback(async () => {
    setError(null);
    try {
      await postJson(`${args.coreUrl}/projects/init`, {});
      const response = await fetch(`${args.coreUrl}/cache`, {method: "DELETE"});
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
      }
      const payload = (await response.json()) as AppCacheClearResponse;
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
  }, [args.coreUrl, nextTranscriptEntryId, threadId]);

  const resetToNewThread = useCallback(() => {
    activeRunAbortController.current?.abort();
    activeRunId.current = null;
    activeRunThreadId.current = null;
    activeRunSequence.current += 1;
    setIdea("");
    setReply("");
    setState("input");
    setEventCount(0);
    setActivities([]);
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
      await postJson<ModeRun>(`${args.coreUrl}/runs/${targetRunId}/cancel`, {});
    } catch (caught) {
      const rawMessage = caught instanceof Error ? caught.message : String(caught);
      const message = interruptErrorMessage(rawMessage);
      setError(message);
    }
  }, [args.coreUrl, nextTranscriptEntryId, runId, threadId]);

  const runIdeaPlan = useCallback(
    async (content: string, existingThreadId?: string) => {
      const submittedContent = content.trim();
      const sequence = activeRunSequence.current + 1;
      activeRunSequence.current = sequence;
      const abortController = new AbortController();
      activeRunAbortController.current = abortController;
      activeRunId.current = null;
      activeRunThreadId.current = existingThreadId ?? threadId ?? null;
      const runActivities: ActivityEntry[] = [];
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
        setEventCount(0);
        setActivities([]);
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
        await postJson(`${args.coreUrl}/projects/init`, {}, {signal: abortController.signal});
        const profiles = await getJson<ProviderProfilesResponse>(
          `${args.coreUrl}/providers/profiles`,
          {signal: abortController.signal},
        );
        if (!isCurrentRun()) {
          finishInterruptedRun(existingThreadId ?? threadId);
          return;
        }
        setProviderProfile(
          (profiles.profiles ?? []).find((profile) => profile.profile === "planner") ?? null,
        );
        const response = existingThreadId
          ? await postJson<StartIdeaPlanRunResponse>(
              `${args.coreUrl}/threads/${existingThreadId}/idea-plan`,
              {content: content.trim()},
              {signal: abortController.signal},
            )
          : await postJson<StartIdeaPlanRunResponse>(
              `${args.coreUrl}/runs/idea-plan`,
              {idea: content.trim()},
              {signal: abortController.signal},
        );
        if (!isCurrentRun()) {
          interruptedRunIds.current.add(response.run.run_id);
          activeRunId.current = response.run.run_id;
          activeRunThreadId.current = response.run.thread_id;
          void postJson<ModeRun>(`${args.coreUrl}/runs/${response.run.run_id}/cancel`, {});
          finishInterruptedRun(response.run.thread_id);
          return;
        }
        activeRunId.current = response.run.run_id;
        activeRunThreadId.current = response.run.thread_id;
        setRunId(response.run.run_id);
        setThreadId(response.run.thread_id);
        const seenEvents: SSEEvent[] = [];
        const pendingActivities: ActivityEntry[] = [];
        let pendingAssistantDelta = "";
        let liveEventCount = 0;
        let flushTimer: NodeJS.Timeout | null = null;
        const flushLiveUi = () => {
          if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }
          if (pendingActivities.length > 0) {
            const nextActivities = pendingActivities.splice(0, pendingActivities.length);
            setActivities((current) => [...current, ...nextActivities].slice(-12));
          }
          if (pendingAssistantDelta.length > 0) {
            const nextDelta = pendingAssistantDelta;
            pendingAssistantDelta = "";
            setAssistantDraft((current) => `${current}${nextDelta}`);
          }
          setEventCount(liveEventCount);
        };
        const scheduleLiveUiFlush = () => {
          if (flushTimer) {
            return;
          }
          flushTimer = setTimeout(flushLiveUi, LIVE_UI_FLUSH_MS);
        };
        await readSseEvents(`${args.coreUrl}${response.events_url}`, (event) => {
          if (
            !isCurrentRun() ||
            interruptedRunIds.current.has(response.run.run_id)
          ) {
            return;
          }
          seenEvents.push(event);
          liveEventCount = seenEvents.length;
          const activity = activityFromEvent(event);
          if (activity) {
            runActivities.push(activity);
            pendingActivities.push(activity);
          }
          if (event.event_type === "assistant.delta") {
            const delta = String(event.payload?.delta ?? "");
            if (delta) {
              pendingAssistantDelta += delta;
            }
          } else if (event.event_type === "assistant.reset") {
            pendingAssistantDelta = "";
            setAssistantDraft("");
          }
          scheduleLiveUiFlush();
        }, abortController.signal);
        flushLiveUi();
        if (
          !isCurrentRun() ||
          interruptedRunIds.current.has(response.run.run_id)
        ) {
          finishInterruptedRun(response.run.thread_id);
          return;
        }
        const finalRun = await getJson<ModeRun>(
          `${args.coreUrl}/runs/${response.run.run_id}`,
          {signal: abortController.signal},
        );
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
        const finalResult = await getJson<RunResultResponse>(
          `${args.coreUrl}/runs/${response.run.run_id}/result`,
          {signal: abortController.signal},
        );
        if (
          !isCurrentRun() ||
          interruptedRunIds.current.has(response.run.run_id)
        ) {
          finishInterruptedRun(response.run.thread_id);
          return;
        }
        setThreadId(finalResult.run.thread_id);
        setSessionName(finalResult.thread.name ?? null);
        void refreshSessionStatus(finalResult.run.thread_id);
        const mergedActivityHistory = {
          ...activityHistoryRef.current,
          [finalResult.run.run_id]: {
            activities: runActivities,
            eventCount: seenEvents.length,
          },
        };
        activityHistoryRef.current = mergedActivityHistory;
        setTranscript(
          transcriptFromMessagesWithActivity(finalResult.messages ?? [], mergedActivityHistory),
        );
        void refreshContextUsage(finalResult.run.thread_id, "");
        setAssistantDraft("");
        setActivities([]);
        setReply("");
        setState("completed");
        if (activeRunAbortController.current === abortController) {
          activeRunAbortController.current = null;
        }
        if (activeRunSequence.current === sequence) {
          activeRunId.current = null;
          activeRunThreadId.current = finalResult.run.thread_id;
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
      args.coreUrl,
      args.idea,
      args.once,
      exit,
      inputEnabled,
      nextTranscriptEntryId,
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
      } else if (command.command === "freeze") {
        await freezeCurrentPlan();
      } else if (command.command === "review") {
        await reviewCurrentPlan(command.value);
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
      renameCurrentThread,
      reviewCurrentPlan,
      resetToNewThread,
      resumeThreadByName,
      runIdeaPlan,
      showCurrentPlan,
      showResumeList,
    ],
  );

  useEffect(() => {
    if (initialCommandHandled.current) {
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
  }, [args.idea, args.resume, args.resumeList, resumeThreadByName, runIdeaPlan, showResumeList]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        setError("Use /quit to exit.");
        return;
      }
      if (key.escape && (state === "loading" || state === "running")) {
        void interruptCurrentRun();
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

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">
        Academic Agent v0
      </Text>
      <Text color="gray">Core: {args.coreUrl}</Text>
      {providerProfile && (
        <Text color="gray">
          Planner: {providerProfile.provider}/{providerProfile.model}
          {providerProfile.will_use_live ? " live" : " mock-safe"}
          {providerProfile.reasoning_effort
            ? ` reasoning=${providerProfile.reasoning_effort}`
            : ""}
        </Text>
      )}
      {threadId && (
        <Text color="gray">
          Session: {sessionName ? `${sessionName} (${threadId})` : threadId}
          {sessionStatus ? ` · plan=${sessionStatus}` : ""}
        </Text>
      )}

      {visibleTranscript.entries.length > 0 && (
        <Box flexDirection="column" gap={1}>
          {visibleTranscript.hiddenCount > 0 && (
            <Text color="gray">
              Showing latest {visibleTranscript.entries.length} transcript item(s) while working;{" "}
              {visibleTranscript.hiddenCount} earlier item(s) are hidden until this run finishes.
            </Text>
          )}
          {visibleTranscript.entries.map((entry) => (
            <TranscriptEntryView key={entry.id} entry={entry} />
          ))}
        </Box>
      )}

      {state === "input" && (
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

      {state === "loading" && (
        <WorkingStatus label={workingLabel} startedAt={workingStartedAt} now={clockNow} />
      )}

      {state === "resume-list" && (
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

      {(state === "running" || state === "error") && (
        <Box flexDirection="column">
          {state === "running" ? (
            <WorkingStatus label={workingLabel} startedAt={workingStartedAt} now={clockNow} />
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
            eventCount={eventCount}
          />
        </Box>
      )}

      {state === "completed" && threadId && (
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

const TranscriptEntryView = ({entry}: {entry: TranscriptEntry}) => {
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
      <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
        <Text bold color="yellow">
          {entry.title}
        </Text>
        {entry.activities.map((activity) => (
          <ActivityLine key={activity.id} activity={activity} />
        ))}
        <Text color="gray">{entry.eventCount} local event(s) captured for trace.</Text>
      </Box>
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

const ActivityStream = ({
  activities,
  assistantDraft,
  eventCount,
}: {
  activities: ActivityEntry[];
  assistantDraft: string;
  eventCount: number;
}) => (
  <Box flexDirection="column" gap={1}>
    <Box flexDirection="column">
      <Text bold color="yellow">
        Working
      </Text>
      {activities.length === 0 ? (
        <Text color="gray">Preparing local run...</Text>
      ) : (
        activities.map((activity) => (
          <ActivityLine key={activity.id} activity={activity} />
        ))
      )}
      <Text color="gray">{eventCount} local event(s) captured for trace.</Text>
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

const ActivityLine = ({activity}: {activity: ActivityEntry}) => {
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
      <Text color="gray">{activity.stage}</Text>{" "}
      <Text>{activity.message}</Text>
    </Text>
  );
};

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
  process.stdout.write(
    "Usage: academic-agent [resume [NAME]|--resume [NAME]] [--core-url URL] [--idea TEXT] [--once]\n" +
      "Commands: /new, /new IDEA, /resume, /resume NAME, /rename, /rename NAME, /plan, /freeze, /review Reject|Revise|Advance, /cache, /clear-cache, /quit\n" +
      "Keys: Esc interrupts the current run.\n",
  );
  process.exit(0);
}

render(<App args={args} />);
