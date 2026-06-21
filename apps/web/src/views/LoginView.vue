<script setup lang="ts">
import { NButton, NCard, NForm, NFormItem, NInput, useMessage } from "naive-ui";
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useMutation } from "@tanstack/vue-query";
import { authApi } from "@/api/endpoints";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const route = useRoute();
const message = useMessage();
const auth = useAuthStore();

const email = ref("");
const password = ref("");

const loginMutation = useMutation({
  mutationFn: () => authApi.login({ email: email.value, password: password.value }),
  onSuccess: (data) => {
    auth.setSession(data.access_token, data.user);
    const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "/";
    router.replace(redirect);
  },
  onError: (error: Error) => message.error(error.message),
});
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-gray-100 p-4">
    <NCard class="w-full max-w-md" title="登录">
      <NForm @submit.prevent="loginMutation.mutate()">
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
          :loading="loginMutation.isPending.value"
        >
          登录
        </NButton>
      </NForm>
      <p class="mt-4 text-center text-sm text-gray-600">
        还没有账号？
        <RouterLink class="text-blue-600 hover:underline" to="/register">注册</RouterLink>
      </p>
    </NCard>
  </div>
</template>
