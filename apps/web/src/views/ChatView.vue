<script setup lang="ts">
import ActivityStream from "@academic-agent/activity-ui/ActivityStream.vue";
import { activityFromEvent, type ActivityEntry } from "@academic-agent/activity-ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import {
  NButton,
  NCard,
  NEmpty,
  NInput,
  NSpin,
  useMessage,
} from "naive-ui";
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { threadsApi } from "@/api/endpoints";
import PlanPanel from "@/components/PlanPanel.vue";
import { useRunEventSource } from "@/composables/useRunEvents";
import type { components } from "@/api/schema";

type Message = components["schemas"]["Message"];

const route = useRoute();
const message = useMessage();
const queryClient = useQueryClient();
const eventSource = useRunEventSource();

const threadId = computed(() =>
  route.name === "thread" ? String(route.params.id) : null,
);

const draft = ref("");
const activities = ref<ActivityEntry[]>([]);
const assistantDraft = ref("");
const stepCount = ref(0);
const activeRunId = ref<string | null>(null);
const streaming = ref(false);

const threadQuery = useQuery({
  queryKey: ["thread", threadId],
  enabled: computed(() => Boolean(threadId.value)),
  queryFn: () => threadsApi.get(threadId.value!),
});

const messagesQuery = useQuery({
  queryKey: ["messages", threadId],
  enabled: computed(() => Boolean(threadId.value)),
  queryFn: () => threadsApi.messages(threadId.value!),
});

const messages = computed<Message[]>(() => messagesQuery.data.value?.messages ?? []);

watch(threadId, () => {
  activities.value = [];
  assistantDraft.value = "";
  stepCount.value = 0;
  activeRunId.value = null;
  eventSource.disconnect();
});

function handleRunEvent(event: {
  event_type: string;
  payload: Record<string, unknown>;
  event_id: string;
  created_at: string;
}) {
  if (event.event_type === "assistant.delta") {
    const delta = String(event.payload?.delta ?? event.payload?.content ?? "");
    assistantDraft.value += delta;
    return;
  }
  if (event.event_type === "assistant.completed") {
    assistantDraft.value = "";
    queryClient.invalidateQueries({ queryKey: ["messages", threadId] });
    return;
  }
  if (event.event_type === "run.completed" || event.event_type === "run.failed") {
    streaming.value = false;
    activeRunId.value = null;
    queryClient.invalidateQueries({ queryKey: ["messages", threadId] });
    queryClient.invalidateQueries({ queryKey: ["threads"] });
  }

  const entry = activityFromEvent(event as Parameters<typeof activityFromEvent>[0]);
  if (entry) {
    activities.value = [...activities.value, entry];
    stepCount.value += 1;
  }
}

async function subscribeToRun(runId: string) {
  activeRunId.value = runId;
  streaming.value = true;
  assistantDraft.value = "";
  try {
    await eventSource.connect(runId, handleRunEvent);
  } catch (error) {
    message.error((error as Error).message);
  } finally {
    streaming.value = false;
  }
}

const sendMutation = useMutation({
  mutationFn: (content: string) => threadsApi.sendMessage(threadId.value!, { content }),
  onSuccess: async (data) => {
    draft.value = "";
    queryClient.invalidateQueries({ queryKey: ["messages", threadId] });
    await subscribeToRun(data.run.run_id);
  },
  onError: (error: Error) => message.error(error.message),
});

function sendMessage() {
  const content = draft.value.trim();
  if (!content || !threadId.value || streaming.value) return;
  sendMutation.mutate(content);
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div v-if="!threadId" class="flex flex-1 items-center justify-center">
      <NEmpty description="选择或新建一个对话开始研究" />
    </div>

    <template v-else>
      <div class="border-b bg-white px-6 py-4">
        <NSpin :show="threadQuery.isLoading.value" size="small">
          <h2 class="text-lg font-semibold">
            {{ threadQuery.data.value?.name || "研究对话" }}
          </h2>
          <p class="text-xs text-gray-500">
            {{ threadQuery.data.value?.current_mode }} · {{ threadQuery.data.value?.lifecycle_state }}
          </p>
        </NSpin>
      </div>

      <div class="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        <NSpin :show="messagesQuery.isLoading.value">
          <NEmpty v-if="!messages.length && !streaming" description="发送第一条消息开始" />
          <div v-else class="space-y-3">
            <div
              v-for="msg in messages"
              :key="msg.message_id"
              class="flex"
              :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
            >
              <NCard
                :class="msg.role === 'user' ? 'max-w-[75%] bg-blue-600 text-white' : 'max-w-[75%]'"
                size="small"
                :bordered="msg.role !== 'user'"
              >
                <p class="whitespace-pre-wrap text-sm">{{ msg.content }}</p>
              </NCard>
            </div>
          </div>
        </NSpin>

        <NCard v-if="streaming || activities.length || assistantDraft" size="small" class="bg-white">
          <ActivityStream
            :activities="activities"
            :assistant-draft="assistantDraft"
            :step-count="stepCount"
            expanded
          />
        </NCard>

        <PlanPanel v-if="threadId" :thread-id="threadId" class="mt-4" />
      </div>

      <div class="border-t bg-white px-6 py-4">
        <div class="flex gap-3">
          <NInput
            v-model:value="draft"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 6 }"
            placeholder="描述你的研究问题..."
            :disabled="streaming || sendMutation.isPending.value"
            @keydown.enter.exact.prevent="sendMessage"
          />
          <NButton
            type="primary"
            :loading="sendMutation.isPending.value || streaming"
            :disabled="!draft.trim()"
            @click="sendMessage"
          >
            发送
          </NButton>
        </div>
        <p v-if="activeRunId" class="mt-2 text-xs text-gray-400">Run: {{ activeRunId }}</p>
      </div>
    </template>
  </div>
</template>
