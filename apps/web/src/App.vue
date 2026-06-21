<script setup lang="ts">
import { NConfigProvider, NMessageProvider, zhCN, dateZhCN } from "naive-ui";
import { RouterView } from "vue-router";
</script>

<template>
  <NConfigProvider :locale="zhCN" :date-locale="dateZhCN">
    <NMessageProvider>
      <RouterView />
    </NMessageProvider>
  </NConfigProvider>
</template>
