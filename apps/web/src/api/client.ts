import { useAuthStore } from "@/stores/auth";
import { createTraceId } from "@/utils/trace";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api/v1";

export class ApiError extends Error {
  readonly status: number;
  readonly traceId?: string;
  readonly body?: unknown;

  constructor(message: string, status: number, traceId?: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.traceId = traceId;
    this.body = body;
  }
}

export type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  auth?: boolean;
  traceId?: string;
};

function buildUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (normalized.startsWith(API_BASE)) {
    return normalized;
  }
  return `${API_BASE}${normalized}`;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const auth = useAuthStore();
  const traceId = options.traceId ?? createTraceId();
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  headers.set("X-Trace-Id", traceId);

  const useAuth = options.auth !== false;
  if (useAuth && auth.token) {
    headers.set("Authorization", `Bearer ${auth.token}`);
  }

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.body);
  }

  const response = await fetch(buildUrl(path), {
    ...options,
    headers,
    body,
  });

  const responseTraceId = response.headers.get("X-Trace-Id") ?? traceId;
  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const payload = isJson ? await response.json().catch(() => undefined) : undefined;

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message: unknown }).message)
        : response.statusText || "Request failed";
    throw new ApiError(message, response.status, responseTraceId, payload);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (payload ?? (await response.text())) as T;
}

export function apiBaseUrl(): string {
  return API_BASE;
}

export function runEventsUrl(runId: string): string {
  return buildUrl(`/runs/${runId}/events`);
}
