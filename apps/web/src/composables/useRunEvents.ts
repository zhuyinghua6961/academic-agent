import { onUnmounted, ref } from "vue";
import { useAuthStore } from "@/stores/auth";
import { runEventsUrl } from "@/api/client";
import { createTraceId } from "@/utils/trace";

export type RunSseEvent = {
  event_id: string;
  run_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
  ordinal: number;
};

export type RunEventHandler = (event: RunSseEvent) => void;

function parseSseChunk(chunk: string): { id?: string; data?: string } | null {
  const lines = chunk.split("\n");
  let id: string | undefined;
  let data: string | undefined;
  for (const line of lines) {
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    } else if (line.startsWith("data:")) {
      data = line.slice(5).trim();
    }
  }
  if (!data) return null;
  return { id, data };
}

/**
 * Authenticated SSE reader. Native EventSource cannot send Authorization headers,
 * so this uses fetch + ReadableStream while preserving EventSource semantics.
 */
export function useRunEventSource() {
  const abortController = ref<AbortController | null>(null);
  const connected = ref(false);
  const lastEventId = ref<string | null>(null);

  async function connect(runId: string, onEvent: RunEventHandler) {
    disconnect();
    const auth = useAuthStore();
    const controller = new AbortController();
    abortController.value = controller;
    connected.value = true;

    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "X-Trace-Id": createTraceId(),
    };
    if (auth.token) {
      headers.Authorization = `Bearer ${auth.token}`;
    }
    if (lastEventId.value) {
      headers["Last-Event-ID"] = lastEventId.value;
    }

    try {
      const response = await fetch(runEventsUrl(runId), {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`SSE failed: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const parsed = parseSseChunk(part);
          if (!parsed?.data) continue;
          if (parsed.id) {
            lastEventId.value = parsed.id;
          }
          try {
            const event = JSON.parse(parsed.data) as RunSseEvent;
            onEvent(event);
          } catch {
            // ignore malformed chunks
          }
        }
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        throw error;
      }
    } finally {
      connected.value = false;
    }
  }

  function disconnect() {
    abortController.value?.abort();
    abortController.value = null;
    connected.value = false;
  }

  onUnmounted(disconnect);

  return {
    connected,
    lastEventId,
    connect,
    disconnect,
  };
}
