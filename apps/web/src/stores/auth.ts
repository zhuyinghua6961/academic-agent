import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { components } from "@/api/schema";

type UserProfile = components["schemas"]["UserProfile"];

const TOKEN_KEY = "academic_agent_access_token";
const USER_KEY = "academic_agent_user";

export const useAuthStore = defineStore("auth", () => {
  const token = ref<string | null>(localStorage.getItem(TOKEN_KEY));
  const user = ref<UserProfile | null>(readStoredUser());

  const isAuthenticated = computed(() => Boolean(token.value));

  function readStoredUser(): UserProfile | null {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as UserProfile;
    } catch {
      return null;
    }
  }

  function setSession(accessToken: string, profile: UserProfile) {
    token.value = accessToken;
    user.value = profile;
    localStorage.setItem(TOKEN_KEY, accessToken);
    localStorage.setItem(USER_KEY, JSON.stringify(profile));
  }

  function clearSession() {
    token.value = null;
    user.value = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  return {
    token,
    user,
    isAuthenticated,
    setSession,
    clearSession,
  };
});
