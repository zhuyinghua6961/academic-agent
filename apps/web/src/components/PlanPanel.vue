<script setup lang="ts">
import { planApi } from "@/api/endpoints";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { NButton, NCard, NInput, NSelect, NSpin, useMessage } from "naive-ui";
import { computed, ref } from "vue";

const props = defineProps<{ threadId: string }>();

const message = useMessage();
const queryClient = useQueryClient();
const feedback = ref("");
const decision = ref<"accept" | "revise" | "reject">("accept");

const planQuery = useQuery({
  queryKey: ["plan", () => props.threadId],
  queryFn: () => planApi.get(props.threadId),
  retry: false,
});

const papersQuery = useQuery({
  queryKey: ["papers", () => props.threadId],
  queryFn: () => planApi.papers(props.threadId),
  retry: false,
});

const hasPlan = computed(() => Boolean(planQuery.data.value?.artifact_id));

const reviewMutation = useMutation({
  mutationFn: () =>
    planApi.review(props.threadId, { decision: decision.value, feedback: feedback.value }),
  onSuccess: () => {
    message.success("评审已提交");
    queryClient.invalidateQueries({ queryKey: ["plan", props.threadId] });
  },
  onError: (e: Error) => message.error(e.message),
});

const freezeMutation = useMutation({
  mutationFn: () => planApi.freeze(props.threadId),
  onSuccess: () => {
    message.success("方案已冻结");
    queryClient.invalidateQueries({ queryKey: ["plan", props.threadId] });
    queryClient.invalidateQueries({ queryKey: ["thread", props.threadId] });
  },
  onError: (e: Error) => message.error(e.message),
});
</script>

<template>
  <NCard v-if="hasPlan" size="small" title="研究方案" class="bg-white">
    <NSpin :show="planQuery.isLoading.value">
      <p class="text-xs text-gray-500 mb-2">状态: {{ planQuery.data.value?.status }}</p>
      <pre
        v-if="planQuery.data.value?.body"
        class="text-xs bg-gray-50 p-3 rounded overflow-auto max-h-48"
      >{{ JSON.stringify(planQuery.data.value?.body, null, 2) }}</pre>

      <div class="mt-4 flex flex-wrap gap-2 items-end">
        <NSelect
          v-model:value="decision"
          :options="[
            { label: '接受', value: 'accept' },
            { label: '修订', value: 'revise' },
            { label: '拒绝', value: 'reject' },
          ]"
          class="w-32"
        />
        <NInput v-model:value="feedback" placeholder="评审意见（可选）" class="flex-1 min-w-[12rem]" />
        <NButton :loading="reviewMutation.isPending.value" @click="reviewMutation.mutate()">
          提交评审
        </NButton>
        <NButton
          type="primary"
          :loading="freezeMutation.isPending.value"
          @click="freezeMutation.mutate()"
        >
          冻结方案
        </NButton>
      </div>
    </NSpin>
  </NCard>

  <NCard v-if="papersQuery.data.value?.papers?.length" size="small" title="文献" class="bg-white mt-3">
    <ul class="text-sm space-y-1">
      <li v-for="(paper, idx) in papersQuery.data.value?.papers" :key="idx">
        {{ (paper as Record<string, unknown>).title ?? JSON.stringify(paper) }}
      </li>
    </ul>
  </NCard>
</template>
