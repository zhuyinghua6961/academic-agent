<script setup lang="ts">
import { NButton, NCard, NForm, NFormItem, NInput, useMessage } from "naive-ui";
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useMutation } from "@tanstack/vue-query";
import { authApi } from "@/api/endpoints";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const message = useMessage();
const auth = useAuthStore();

const email = ref("");
const password = ref("");
const displayName = ref("");

const registerMutation = useMutation({
  mutationFn: () =>
    authApi.register({
      email: email.value,
      password: password.value,
      display_name: displayName.value,
    }),
  onSuccess: (data) => {
    auth.setSession(data.access_token, data.user);
    router.replace("/");
  },
  onError: (error: Error) => message.error(error.message),
});
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-gray-100 p-4">
    <NCard class="w-full max-w-md" title="注册">
      <NForm @submit.prevent="registerMutation.mutate()">
        <NFormItem label="显示名称">
          <NInput v-model:value="displayName" placeholder="你的名字" />
        </NFormItem>
        <NFormItem label="邮箱">
          <NInput v-model:value="email" type="text" placeholder="you@example.com" />
        </NFormItem>
        <NFormItem label="密码">
          <NInput v-model:value="password" type="password" show-password-on="click" />
        </NFormItem>
        <NButton
          block
          type="primary"
          attr-type="submit"
          :loading="registerMutation.isPending.value"
        >
          注册
        </NButton>
      </NForm>
      <p class="mt-4 text-center text-sm text-gray-600">
        已有账号？
        <RouterLink class="text-blue-600 hover:underline" to="/login">登录</RouterLink>
      </p>
    </NCard>
  </div>
</template>
