<script setup lang="ts">
import { NLayout, NLayoutSider, NLayoutContent } from "naive-ui";
import { RouterView } from "vue-router";
import ThreadSidebar from "@/components/ThreadSidebar.vue";
</script>

<template>
  <NLayout has-sider class="h-screen">
    <NLayoutSider
      bordered
      :width="280"
      :native-scrollbar="false"
      class="bg-white"
    >
      <ThreadSidebar />
    </NLayoutSider>
    <NLayoutContent class="h-screen overflow-hidden bg-gray-50">
      <RouterView />
    </NLayoutContent>
  </NLayout>
</template>
