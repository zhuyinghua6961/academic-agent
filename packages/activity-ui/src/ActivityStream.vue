<script setup lang="ts">
import { computed } from "vue";
import type { ActivityEntry } from "./activity.js";
import { STAGE_LABELS } from "./stage-labels.js";

const props = withDefaults(
  defineProps<{
    activities: ActivityEntry[];
    assistantDraft?: string;
    stepCount?: number;
    expanded?: boolean;
    previewLimit?: number;
  }>(),
  {
    assistantDraft: "",
    stepCount: 0,
    expanded: false,
    previewLimit: 6,
  },
);

const visible = computed(() => {
  if (props.expanded || props.activities.length <= props.previewLimit) {
    return props.activities;
  }
  return props.activities.slice(-props.previewLimit);
});

function statusClass(status: ActivityEntry["status"]): string {
  switch (status) {
    case "completed":
      return "text-green-600";
    case "error":
      return "text-red-600";
    case "started":
      return "text-cyan-600";
    default:
      return "text-amber-600";
  }
}

function statusMarker(status: ActivityEntry["status"]): string {
  switch (status) {
    case "completed":
      return "✓";
    case "error":
      return "!";
    case "started":
      return "→";
    default:
      return "•";
  }
}

const footer = computed(() => {
  const hidden = props.activities.length - visible.value.length;
  if (hidden > 0) {
    return `另有 ${hidden} 步已折叠`;
  }
  if (props.stepCount > 0) {
    return `共 ${props.stepCount} 步`;
  }
  return "";
});
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-col gap-1">
      <h3 class="text-sm font-semibold text-amber-700">Working</h3>
      <p v-if="visible.length === 0" class="text-sm text-gray-500">Preparing run...</p>
      <ul v-else class="flex flex-col gap-1">
        <li
          v-for="activity in visible"
          :key="activity.id"
          class="text-sm leading-relaxed"
        >
          <span :class="statusClass(activity.status)" class="font-mono mr-1">
            {{ statusMarker(activity.status) }}
          </span>
          <span class="text-gray-500 mr-1">
            {{ STAGE_LABELS[activity.stage] ?? activity.stage }}
          </span>
          <span>{{ activity.message }}</span>
        </li>
      </ul>
      <p v-if="footer" class="text-xs text-gray-400">{{ footer }}</p>
    </div>
    <div
      v-if="assistantDraft"
      class="rounded-md border border-green-300 bg-green-50 p-3"
    >
      <p class="text-sm font-semibold text-green-800 mb-1">Academic Agent</p>
      <p class="text-sm whitespace-pre-wrap">{{ assistantDraft }}</p>
    </div>
  </div>
</template>
