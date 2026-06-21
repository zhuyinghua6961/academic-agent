import { apiFetch } from "@/api/client";
import type { components } from "@/api/schema";

type AuthResponse = components["schemas"]["AuthResponse"];
type LoginRequest = components["schemas"]["LoginRequest"];
type RegisterRequest = components["schemas"]["RegisterRequest"];
type UserProfile = components["schemas"]["UserProfile"];
type ProviderSettingsResponse = components["schemas"]["ProviderSettingsResponse"];
type ProviderSettingsRequest = components["schemas"]["ProviderSettingsRequest"];
type VerifyProviderRequest = components["schemas"]["VerifyProviderRequest"];
type SearchSettingsResponse = components["schemas"]["SearchSettingsResponse"];
type SearchSettingsRequest = components["schemas"]["SearchSettingsRequest"];
type VerifySearchRequest = components["schemas"]["VerifySearchRequest"];
type VerifyResponse = components["schemas"]["VerifyResponse"];
type ProjectListResponse = components["schemas"]["ProjectListResponse"];
type CreateProjectRequest = components["schemas"]["CreateProjectRequest"];
type Project = components["schemas"]["Project"];
type ThreadListResponse = components["schemas"]["ThreadListResponse"];
type CreateThreadRequest = components["schemas"]["CreateThreadRequest"];
type Thread = components["schemas"]["Thread"];
type MessageListResponse = components["schemas"]["MessageListResponse"];
type SendMessageRequest = components["schemas"]["SendMessageRequest"];
type StartRunResponse = components["schemas"]["StartRunResponse"];
type Run = components["schemas"]["Run"];

export const authApi = {
  login: (body: LoginRequest) =>
    apiFetch<AuthResponse>("/auth/login", { method: "POST", body, auth: false }),
  register: (body: RegisterRequest) =>
    apiFetch<AuthResponse>("/auth/register", { method: "POST", body, auth: false }),
  me: () => apiFetch<UserProfile>("/auth/me"),
};

export const settingsApi = {
  getProviders: () => apiFetch<ProviderSettingsResponse>("/settings/providers"),
  putProviders: (body: ProviderSettingsRequest) =>
    apiFetch<ProviderSettingsResponse>("/settings/providers", { method: "PUT", body }),
  verifyProvider: (body: VerifyProviderRequest) =>
    apiFetch<VerifyResponse>("/settings/providers/verify", { method: "POST", body }),
  getSearch: () => apiFetch<SearchSettingsResponse>("/settings/search"),
  putSearch: (body: SearchSettingsRequest) =>
    apiFetch<SearchSettingsResponse>("/settings/search", { method: "PUT", body }),
  verifySearch: (body: VerifySearchRequest) =>
    apiFetch<VerifyResponse>("/settings/search/verify", { method: "POST", body }),
};

export const projectsApi = {
  list: () => apiFetch<ProjectListResponse>("/projects"),
  create: (body: CreateProjectRequest) =>
    apiFetch<Project>("/projects", { method: "POST", body }),
};

export const threadsApi = {
  list: (projectId?: string) => {
    const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
    return apiFetch<ThreadListResponse>(`/threads${query}`);
  },
  create: (body: CreateThreadRequest) =>
    apiFetch<Thread>("/threads", { method: "POST", body }),
  get: (threadId: string) => apiFetch<Thread>(`/threads/${threadId}`),
  messages: (threadId: string) => apiFetch<MessageListResponse>(`/threads/${threadId}/messages`),
  sendMessage: (threadId: string, body: SendMessageRequest) =>
    apiFetch<StartRunResponse>(`/threads/${threadId}/messages`, { method: "POST", body }),
};

export const runsApi = {
  get: (runId: string) => apiFetch<Run>(`/runs/${runId}`),
  cancel: (runId: string) => apiFetch<Run>(`/runs/${runId}/cancel`, { method: "POST" }),
};

type PlanResponse = components["schemas"]["PlanResponse"];
type ReviewPlanRequest = components["schemas"]["ReviewPlanRequest"];
type ReviewPlanResponse = components["schemas"]["ReviewPlanResponse"];
type FreezePlanResponse = components["schemas"]["FreezePlanResponse"];
type PapersResponse = components["schemas"]["PapersResponse"];

export const planApi = {
  get: (threadId: string) => apiFetch<PlanResponse>(`/threads/${threadId}/plan`),
  review: (threadId: string, body: ReviewPlanRequest) =>
    apiFetch<ReviewPlanResponse>(`/threads/${threadId}/plan/review`, { method: "POST", body }),
  freeze: (threadId: string) =>
    apiFetch<FreezePlanResponse>(`/threads/${threadId}/plan/freeze`, { method: "POST" }),
  papers: (threadId: string) => apiFetch<PapersResponse>(`/threads/${threadId}/papers`),
};
