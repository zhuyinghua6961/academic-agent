<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import {
  NButton,
  NDivider,
  NEmpty,
  NList,
  NListItem,
  NSpin,
  NText,
  useMessage,
} from "naive-ui";
import { computed } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { projectsApi, threadsApi } from "@/api/endpoints";
import { useAuthStore } from "@/stores/auth";

const route = useRoute();
const router = useRouter();
const message = useMessage();
const queryClient = useQueryClient();
const auth = useAuthStore();

const projectsQuery = useQuery({
  queryKey: ["projects"],
  queryFn: () => projectsApi.list(),
});

const activeProjectId = computed(() => projectsQuery.data.value?.projects[0]?.project_id);

const threadsQuery = useQuery({
  queryKey: ["threads", activeProjectId],
  enabled: computed(() => Boolean(activeProjectId.value)),
  queryFn: () => threadsApi.list(activeProjectId.value),
});

const createProjectMutation = useMutation({
  mutationFn: () => projectsApi.create({ name: "Default Project" }),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ["projects"] });
  },
  onError: (error: Error) => message.error(error.message),
});

const createThreadMutation = useMutation({
  mutationFn: () => {
    const projectId = activeProjectId.value;
    if (!projectId) {
      throw new Error("No project available");
    }
    return threadsApi.create({ project_id: projectId });
  },
  onSuccess: (thread) => {
    queryClient.invalidateQueries({ queryKey: ["threads"] });
    router.push({ name: "thread", params: { id: thread.thread_id } });
  },
  onError: (error: Error) => message.error(error.message),
});

const activeThreadId = computed(() => {
  if (route.name === "thread") {
    return String(route.params.id);
  }
  return null;
});

const threads = computed(() => threadsQuery.data.value?.threads ?? []);

async function ensureProject() {
  if (!projectsQuery.data.value?.projects.length) {
    await createProjectMutation.mutateAsync();
  }
}

async function handleNewThread() {
  await ensureProject();
  createThreadMutation.mutate();
}

function logout() {
  auth.clearSession();
  router.push({ name: "login" });
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex items-center justify-between border-b px-4 py-3">
      <div>
        <p class="text-sm font-semibold">Academic Agent</p>
        <p v-if="auth.user" class="text-xs text-gray-500">{{ auth.user.display_name }}</p>
      </div>
      <div class="flex gap-2">
        <RouterLink to="/settings">
          <NButton size="small" quaternary>设置</NButton>
        </RouterLink>
        <NButton size="small" quaternary @click="logout">退出</NButton>
      </div>
    </div>

    <div class="px-3 py-2">
      <NButton
        block
        type="primary"
        :loading="createThreadMutation.isPending.value"
        @click="handleNewThread"
      >
        新建对话
      </NButton>
    </div>

    <NDivider class="!my-2" />

    <div class="flex-1 overflow-y-auto px-2 pb-4">
      <NSpin :show="threadsQuery.isLoading.value || projectsQuery.isLoading.value">
        <NEmpty
          v-if="!threads.length"
          description="暂无对话"
          class="mt-8"
        />
        <NList v-else hoverable clickable>
          <NListItem
            v-for="thread in threads"
            :key="thread.thread_id"
            :class="activeThreadId === thread.thread_id ? 'bg-blue-50 rounded' : ''"
            @click="router.push({ name: 'thread', params: { id: thread.thread_id } })"
          >
            <div class="px-2 py-1">
              <NText strong>{{ thread.title || "未命名对话" }}</NText>
              <p v-if="thread.last_message_preview" class="text-xs text-gray-500 truncate">
                {{ thread.last_message_preview }}
              </p>
            </div>
          </NListItem>
        </NList>
      </NSpin>
    </div>
  </div>
</template>
