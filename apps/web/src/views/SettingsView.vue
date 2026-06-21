<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import {
  NButton,
  NCard,
  NForm,
  NFormItem,
  NInput,
  NSelect,
  NSpace,
  NSpin,
  NTag,
  useMessage,
} from "naive-ui";
import { computed, reactive, ref } from "vue";
import { settingsApi } from "@/api/endpoints";
import type { components } from "@/api/schema";

type ProviderProfile = components["schemas"]["ProviderProfileMasked"];
type SearchSource = components["schemas"]["SearchSourceMasked"];

const message = useMessage();
const queryClient = useQueryClient();

const providerProfiles = [
  "planner",
  "reviewer",
  "writer",
  "extractor",
  "embedder",
] as const;

const providersQuery = useQuery({
  queryKey: ["settings", "providers"],
  queryFn: () => settingsApi.getProviders(),
});

const searchQuery = useQuery({
  queryKey: ["settings", "search"],
  queryFn: () => settingsApi.getSearch(),
});

const providerForm = reactive({
  profile: "planner" as (typeof providerProfiles)[number],
  provider: "openai",
  model: "gpt-4o-mini",
  api_key: "",
  base_url: "",
});

const searchForm = reactive({
  source: "semantic_scholar",
  api_key: "",
});

const verifyingProvider = ref(false);
const verifyingSearch = ref(false);

const providerOptions = providerProfiles.map((value) => ({
  label: value,
  value,
}));

const configuredProfiles = computed(() => {
  const profiles = providersQuery.data.value?.profiles ?? {};
  return Object.entries(profiles) as [string, ProviderProfile][];
});

const searchSources = computed(() => searchQuery.data.value?.sources ?? []);

function fillProviderFromSelection(profile: string) {
  const existing = providersQuery.data.value?.profiles?.[profile];
  if (!existing) return;
  providerForm.provider = existing.provider ?? providerForm.provider;
  providerForm.model = existing.model ?? providerForm.model;
}

const saveProviderMutation = useMutation({
  mutationFn: () =>
    settingsApi.putProviders({
      profile: providerForm.profile,
      provider: providerForm.provider,
      model: providerForm.model,
      api_key: providerForm.api_key,
      base_url: providerForm.base_url || undefined,
    }),
  onSuccess: () => {
    message.success("Provider 设置已保存");
    providerForm.api_key = "";
    queryClient.invalidateQueries({ queryKey: ["settings", "providers"] });
  },
  onError: (error: Error) => message.error(error.message),
});

const saveSearchMutation = useMutation({
  mutationFn: () =>
    settingsApi.putSearch({
      source: searchForm.source,
      api_key: searchForm.api_key,
    }),
  onSuccess: () => {
    message.success("Search 设置已保存");
    searchForm.api_key = "";
    queryClient.invalidateQueries({ queryKey: ["settings", "search"] });
  },
  onError: (error: Error) => message.error(error.message),
});

async function verifyProvider() {
  verifyingProvider.value = true;
  try {
    const result = await settingsApi.verifyProvider({
      profile: providerForm.profile,
      provider: providerForm.provider,
      model: providerForm.model,
      api_key: providerForm.api_key,
      base_url: providerForm.base_url || undefined,
    });
    message[result.ok ? "success" : "warning"](result.message ?? (result.ok ? "验证成功" : "验证失败"));
  } catch (error) {
    message.error((error as Error).message);
  } finally {
    verifyingProvider.value = false;
  }
}

async function verifySearch() {
  verifyingSearch.value = true;
  try {
    const result = await settingsApi.verifySearch({
      source: searchForm.source,
      api_key: searchForm.api_key,
    });
    message[result.ok ? "success" : "warning"](result.message ?? (result.ok ? "验证成功" : "验证失败"));
  } catch (error) {
    message.error((error as Error).message);
  } finally {
    verifyingSearch.value = false;
  }
}
</script>

<template>
  <div class="h-full overflow-y-auto p-6">
    <div class="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 class="text-2xl font-semibold">设置</h1>
        <p class="text-sm text-gray-500">配置 LLM Provider 与 Search API</p>
      </div>

      <NSpin :show="providersQuery.isLoading.value">
        <NCard title="Provider 设置">
          <NForm label-placement="top">
            <NFormItem label="Profile">
              <NSelect
                v-model:value="providerForm.profile"
                :options="providerOptions"
                @update:value="fillProviderFromSelection"
              />
            </NFormItem>
            <NFormItem label="Provider">
              <NInput v-model:value="providerForm.provider" />
            </NFormItem>
            <NFormItem label="Model">
              <NInput v-model:value="providerForm.model" />
            </NFormItem>
            <NFormItem label="API Key">
              <NInput v-model:value="providerForm.api_key" type="password" show-password-on="click" />
            </NFormItem>
            <NFormItem label="Base URL (optional)">
              <NInput v-model:value="providerForm.base_url" placeholder="https://api.openai.com/v1" />
            </NFormItem>
            <NSpace>
              <NButton
                type="primary"
                :loading="saveProviderMutation.isPending.value"
                @click="saveProviderMutation.mutate()"
              >
                保存
              </NButton>
              <NButton :loading="verifyingProvider" @click="verifyProvider">验证连接</NButton>
            </NSpace>
          </NForm>

          <div v-if="configuredProfiles.length" class="mt-4 space-y-2">
            <p class="text-sm font-medium text-gray-600">已配置 Profiles</p>
            <div class="flex flex-wrap gap-2">
              <NTag
                v-for="[name, profile] in configuredProfiles"
                :key="name"
                :type="profile.configured ? 'success' : 'default'"
              >
                {{ name }}
                <span v-if="profile.api_key_hint" class="ml-1 text-xs">({{ profile.api_key_hint }})</span>
              </NTag>
            </div>
          </div>
        </NCard>
      </NSpin>

      <NSpin :show="searchQuery.isLoading.value">
        <NCard title="Search 设置">
          <NForm label-placement="top">
            <NFormItem label="Source">
              <NInput v-model:value="searchForm.source" placeholder="semantic_scholar" />
            </NFormItem>
            <NFormItem label="API Key">
              <NInput v-model:value="searchForm.api_key" type="password" show-password-on="click" />
            </NFormItem>
            <NSpace>
              <NButton
                type="primary"
                :loading="saveSearchMutation.isPending.value"
                @click="saveSearchMutation.mutate()"
              >
                保存
              </NButton>
              <NButton :loading="verifyingSearch" @click="verifySearch">验证连接</NButton>
            </NSpace>
          </NForm>

          <div v-if="searchSources.length" class="mt-4 space-y-2">
            <p class="text-sm font-medium text-gray-600">已配置 Sources</p>
            <div class="flex flex-wrap gap-2">
              <NTag
                v-for="source in searchSources as SearchSource[]"
                :key="source.source"
                :type="source.configured ? 'success' : 'default'"
              >
                {{ source.source }}
                <span v-if="source.api_key_hint" class="ml-1 text-xs">({{ source.api_key_hint }})</span>
              </NTag>
            </div>
          </div>
        </NCard>
      </NSpin>
    </div>
  </div>
</template>
