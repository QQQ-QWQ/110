<script setup lang="ts">
import AppIcon from './AppIcon.vue';
import { useToast } from '../composables/useToast';

/**
 * ToastHost —— 全局提示宿主，挂在 App 根节点（Teleport 到 body）。
 *
 * 用 aria-live="polite" 让读屏礼貌播报；错误提示不自动消失，
 * 保证「失败不会被显示成成功」且用户确实看到。
 */
const { toasts, dismiss } = useToast();
</script>

<template>
  <Teleport to="body">
    <div class="toast-host" role="status" aria-live="polite">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="`is-${t.kind}`">
        <span class="toast-dot" aria-hidden="true" />
        <span class="toast-msg">{{ t.message }}</span>
        <button class="toast-close" type="button" aria-label="关闭提示" @click="dismiss(t.id)">
          <AppIcon name="close" />
        </button>
      </div>
    </div>
  </Teleport>
</template>
