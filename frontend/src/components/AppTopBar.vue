<script setup lang="ts">
import { computed } from 'vue';
import type { UserBrief } from '../types';
import { initialsOf } from '../utils/format';

/**
 * AppTopBar —— 顶部导航（纯展示组件）。
 *
 * 只负责渲染与派发事件，用户数据的获取与登出副作用留在 App.vue，
 * 这样顶栏可以在任意布局中复用（例如未来做嵌入态时替换掉）。
 */
const props = defineProps<{ user: UserBrief | null }>();
defineEmits<{ logout: [] }>();

const initials = computed(() => initialsOf(props.user?.name));
</script>

<template>
  <header class="topbar">
    <router-link class="brand" :to="{ name: 'list' }">
      <span class="brand-mark" aria-hidden="true">需</span>
      <span class="brand-text">需求与验收协作台</span>
    </router-link>

    <div class="topbar-spacer" />

    <div class="topbar-user">
      <span class="avatar" aria-hidden="true">{{ initials }}</span>
      <span class="topbar-username">{{ user?.name ?? '未登录' }}</span>
      <button class="btn btn-sm btn-ghost" type="button" @click="$emit('logout')">退出</button>
    </div>
  </header>
</template>
