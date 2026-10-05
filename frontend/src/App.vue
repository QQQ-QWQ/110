<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from './api';
import { setAuthed } from './router';
import { useCurrentUser } from './composables/useCurrentUser';
import AppTopBar from './components/AppTopBar.vue';
import ToastHost from './components/ToastHost.vue';

/**
 * App —— 应用外壳。
 *
 * 只承担三件事：登录态、顶栏、全局提示宿主。
 * 页面级布局与业务逻辑全部下沉到 views/，外壳不感知任何业务概念。
 */
const route = useRoute();
const router = useRouter();
const { current: user, refresh, clear } = useCurrentUser();

/** 登录页不显示顶栏，避免未登录时出现「退出」等无意义入口 */
const showChrome = computed(() => route.name !== 'login');

watch(
  () => route.fullPath,
  async () => {
    if (route.name === 'login') {
      clear();
      return;
    }
    await refresh();
  },
  { immediate: true },
);

async function logout(): Promise<void> {
  try {
    await api.logout();
  } catch {
    /* 会话可能已过期，登出失败也应让本地回到登录页 */
  }
  setAuthed(false);
  clear();
  await router.push({ name: 'login' });
}
</script>

<template>
  <div class="app-shell">
    <a class="skip-link" href="#main-content">跳到主要内容</a>

    <AppTopBar v-if="showChrome" :user="user" @logout="logout" />

    <router-view />

    <ToastHost />
  </div>
</template>
