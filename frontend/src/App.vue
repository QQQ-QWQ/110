<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from './api';
import { setAuthed } from './router';
import type { UserBrief } from './types';

const route = useRoute();
const router = useRouter();
const user = ref<UserBrief | null>(null);

const showChrome = computed(() => route.name !== 'login');
const initials = computed(() => (user.value?.name ?? '?').slice(0, 1).toUpperCase());

async function loadUser(): Promise<void> {
  if (route.name === 'login') {
    user.value = null;
    return;
  }
  try {
    user.value = await api.me();
  } catch {
    user.value = null;
  }
}

watch(() => route.fullPath, loadUser, { immediate: true });

async function logout(): Promise<void> {
  try {
    await api.logout();
  } catch {
    /* 会话可能已过期，忽略 */
  }
  setAuthed(false);
  user.value = null;
  await router.push({ name: 'login' });
}
</script>

<template>
  <div class="app-shell">
    <header v-if="showChrome" class="topbar">
      <router-link class="brand" :to="{ name: 'list' }">
        <span class="brand-mark">需</span>
        <span>需求与验收协作台</span>
      </router-link>

      <div class="topbar-spacer" />

      <div class="topbar-user">
        <span class="avatar">{{ initials }}</span>
        <span>{{ user?.name ?? '未登录' }}</span>
        <button class="btn btn-sm btn-ghost" type="button" @click="logout">退出</button>
      </div>
    </header>

    <router-view />
  </div>
</template>
